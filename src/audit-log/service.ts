import type {
  AuditAction,
  AuditEntry,
  AuditLoggerConfig,
  AuditUserResolver,
  CreateAuditLogInput,
  JsonValue,
  PrismaMiddlewareParams,
} from "./types";
import {
  compactSnapshot,
  deepClone,
  diffObjects,
  mapPrismaActionToAuditAction,
  mergeMetadata,
  omitFields,
  redactSensitiveFields,
} from "./utils";

/**
 * Minimal shape of the Prisma `auditLog` delegate used internally by
 * AuditLogger. The public constructor accepts `unknown` so that any Prisma
 * client (standard, extended, or Driver Adapter) can be passed without
 * importing the generated client types.
 */
interface AuditLogDelegate {
  create: (args: { data: AuditEntry }) => Promise<unknown>;
  createMany?: (args: { data: AuditEntry[]; skipDuplicates?: boolean }) => Promise<unknown>;
}

function getAuditLogDelegate(prisma: unknown): AuditLogDelegate {
  const record = prisma as Record<string, unknown>;
  const auditLog = record.auditLog;

  if (
    auditLog &&
    typeof auditLog === "object" &&
    "create" in auditLog &&
    typeof (auditLog as Record<string, unknown>).create === "function"
  ) {
    return auditLog as unknown as AuditLogDelegate;
  }

  throw new Error(
    "[AuditLogger] Provided prisma client does not have an auditLog delegate."
  );
}

/**
 * A reusable, model-agnostic audit logger.
 *
 * Usage:
 *
 *   const audit = new AuditLogger(prisma, {
 *     userId: () => getCurrentUserId(),
 *     requestContext: extractRequestContext(request),
 *     sensitiveFields: ["password", "token", "secret"],
 *     excludedModels: ["AuditLog"],
 *   });
 *
 *   // Automatic logging via Prisma middleware
 *   prisma.$use(audit.createMiddleware());
 *
 *   // Or manual logging
 *   await audit.log({ model: "User", recordId: 1, action: "UPDATE", oldData, newData });
 */
export class AuditLogger {
  private readonly userIdResolver: AuditUserResolver;
  private readonly auditLog: AuditLogDelegate;

  constructor(
    private readonly prisma: unknown,
    private readonly config: AuditLoggerConfig = {}
  ) {
    this.userIdResolver =
      typeof config.userId === "function"
        ? config.userId
        : () => (config.userId as number | null | undefined) ?? null;
    this.auditLog = getAuditLogDelegate(prisma);
  }

  /**
   * Create a manual audit entry.
   */
  async log(input: CreateAuditLogInput): Promise<void> {
    const entry = await this.buildEntry(input);
    await this.persist(entry);
  }

  /**
   * Create many manual audit entries in a single database call.
   */
  async logMany(inputs: CreateAuditLogInput[]): Promise<void> {
    if (inputs.length === 0) return;

    const entries: AuditEntry[] = [];
    for (const input of inputs) {
      entries.push(await this.buildEntry(input));
    }

    await this.persistMany(entries);
  }

  /**
   * Public helpers used by Prisma extensions and advanced integrations.
   */
  async logCreate(model: string, newRecord: Record<string, unknown> | null | undefined): Promise<void> {
    await this.logAfterMutation(model, "CREATE", undefined, newRecord);
  }

  async logUpdate(
    model: string,
    oldRecord: Record<string, unknown> | null | undefined,
    newRecord: Record<string, unknown> | null | undefined
  ): Promise<void> {
    await this.logAfterMutation(model, "UPDATE", oldRecord ?? undefined, newRecord);
  }

  async logUpsert(
    model: string,
    oldRecord: Record<string, unknown> | null | undefined,
    newRecord: Record<string, unknown> | null | undefined
  ): Promise<void> {
    // If a record existed before, treat it as UPDATE; otherwise CREATE.
    const action: AuditAction = oldRecord ? "UPDATE" : "CREATE";
    await this.logAfterMutation(model, action, oldRecord ?? undefined, newRecord);
  }

  async logDelete(model: string, oldRecord: Record<string, unknown> | null | undefined): Promise<void> {
    if (!oldRecord) return;
    const id = this.extractRecordId(oldRecord);
    if (id === null) return;

    await this.log({
      model,
      recordId: id,
      action: "DELETE",
      oldData: oldRecord,
      newData: null,
    });
  }

  /**
   * Build a Prisma middleware that automatically logs mutations.
   */
  createMiddleware() {
    const logger = this;

    return async function auditMiddleware(
      params: PrismaMiddlewareParams,
      next: (params: PrismaMiddlewareParams) => Promise<unknown>
    ): Promise<unknown> {
      const action = mapPrismaActionToAuditAction(params.action);
      if (!action) return next(params);

      const model = params.model;
      if (!logger.shouldAuditModel(model)) return next(params);

      // Batch operations are summarized to avoid blocking the response.
      if (
        (params.action === "createMany" || params.action === "deleteMany" || params.action === "updateMany")
      ) {
        if (logger.config.logBatchOperations === false) return next(params);
        const result = await next(params);
        await logger.logBatchSummary(params, result as Record<string, unknown>);
        return result;
      }

      if (params.action === "create") {
        const result = await next(params);
        await logger.logCreate(model!, result as Record<string, unknown>);
        return result;
      }

      if (params.action === "update") {
        const where = params.args.where as Record<string, unknown>;
        const oldRecord = await logger.findExistingRecord(model!, where);
        const result = await next(params);
        await logger.logUpdate(model!, oldRecord, result as Record<string, unknown>);
        return result;
      }

      if (params.action === "upsert") {
        const where = params.args.where as Record<string, unknown> | undefined;
        const oldRecord = where ? await logger.findExistingRecord(model!, where) : undefined;
        const result = await next(params);
        await logger.logUpsert(model!, oldRecord, result as Record<string, unknown>);
        return result;
      }

      // delete is intentionally left to explicit logging or extensions because
      // fetching the old record before deletion in middleware requires an extra
      // round-trip that may not be desirable in every setup.
      return next(params);
    };
  }

  /**
   * Build a complete AuditEntry from a user input, applying defaults,
   * redaction, diff calculation, and null-field compaction.
   *
   * Diff is computed BEFORE redaction so that fields whose raw values differ
   * but become identical after redaction (e.g. password) are still recorded as
   * changed.
   */
  private async buildEntry(input: CreateAuditLogInput): Promise<AuditEntry> {
    const userId = await this.userIdResolver();
    const requestContext = this.config.requestContext ?? {};

    const omittedOld = omitFields(input.oldData ?? {}, this.config.omitFields ?? []) as Record<string, unknown>;
    const omittedNew = omitFields(input.newData ?? {}, this.config.omitFields ?? []) as Record<string, unknown>;

    const sensitiveFields = this.config.sensitiveFields ?? [];

    let changedFields: string[] | undefined;
    let finalOldData: Record<string, unknown> | null;
    let finalNewData: Record<string, unknown> | null;

    if (input.action === "UPDATE") {
      const diff = diffObjects(omittedOld, omittedNew);
      changedFields =
        input.changedFields ?? (diff.changedFields.length > 0 ? diff.changedFields : undefined);

      finalOldData = compactSnapshot(
        redactSensitiveFields(diff.oldData, sensitiveFields) as Record<string, unknown> | null
      );
      finalNewData = compactSnapshot(
        redactSensitiveFields(diff.newData, sensitiveFields) as Record<string, unknown> | null
      );
    } else {
      finalOldData = compactSnapshot(
        redactSensitiveFields(omittedOld, sensitiveFields) as Record<string, unknown> | null
      );
      finalNewData = compactSnapshot(
        redactSensitiveFields(omittedNew, sensitiveFields) as Record<string, unknown> | null
      );
    }

    return {
      userId,
      model: input.model,
      recordId: input.recordId,
      action: input.action,
      oldData: finalOldData as JsonValue,
      newData: finalNewData as JsonValue,
      changedFields: changedFields ?? null,
      ipAddress: requestContext.ipAddress ?? null,
      userAgent: requestContext.userAgent ?? null,
      requestPath: requestContext.requestPath ?? null,
      requestMethod: requestContext.requestMethod ?? null,
      metadata: (mergeMetadata(this.config.defaultMetadata, input.metadata) as JsonValue) ?? null,
    };
  }

  /**
   * Persist a single audit entry, swallowing errors so the original business
   * operation is not affected. Errors are forwarded to `config.onError`.
   */
  private async persist(entry: AuditEntry): Promise<void> {
    try {
      await this.auditLog.create({ data: entry });
    } catch (error) {
      this.handleError(error as Error, entry);
    }
  }

  private async persistMany(entries: AuditEntry[]): Promise<void> {
    try {
      if (this.auditLog.createMany) {
        await this.auditLog.createMany({ data: entries, skipDuplicates: true });
      } else {
        for (const entry of entries) {
          await this.auditLog.create({ data: entry });
        }
      }
    } catch (error) {
      this.handleError(error as Error, entries[0]);
    }
  }

  private handleError(error: Error, entry: Partial<AuditEntry>): void {
    if (this.config.onError) {
      this.config.onError(error, entry);
    } else {
      // In production, send to your observability platform instead of console.
      // eslint-disable-next-line no-console
      console.error("[AuditLogger] Failed to write audit log:", error.message, entry);
    }
  }

  /**
   * Determine whether a model should be audited based on include/exclude lists.
   */
  shouldAuditModel(model: string | undefined): boolean {
    if (!model) return false;
    if (model === "AuditLog") return false;

    const { includedModels, excludedModels } = this.config;

    if (excludedModels?.some((m) => m.toLowerCase() === model.toLowerCase())) {
      return false;
    }

    if (includedModels && includedModels.length > 0) {
      return includedModels.some((m) => m.toLowerCase() === model.toLowerCase());
    }

    return true;
  }

  /**
   * Fetch the existing record before an update so we can snapshot the old data.
   */
  private async findExistingRecord(
    model: string,
    where: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const delegate = (this.prisma as Record<string, unknown>)[model];
      if (
        !delegate ||
        typeof delegate !== "object" ||
        typeof (delegate as Record<string, unknown>).findUnique !== "function"
      ) {
        return undefined;
      }

      const findUnique = (delegate as Record<string, unknown>).findUnique as (args: {
        where: Record<string, unknown>;
      }) => Promise<unknown>;
      const record = await findUnique({ where });
      return record ? (record as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Log after a single-record mutation.
   */
  async logAfterMutation(
    model: string,
    action: AuditAction,
    oldRecord: Record<string, unknown> | undefined,
    newRecord: Record<string, unknown> | null | undefined
  ): Promise<void> {
    if (!newRecord) return;

    const id = this.extractRecordId(newRecord);
    if (id === null) return;

    await this.log({
      model,
      recordId: id,
      action,
      oldData: oldRecord,
      newData: newRecord,
    });
  }

  /**
   * Best-effort summary log for batch operations. Production systems should
   * prefer explicit manual logging with the full affected row set.
   */
  async logBatchSummary(
    params: { model?: string; action: string; args: Record<string, unknown> },
    result: Record<string, unknown>
  ): Promise<void> {
    if (!params.model) return;

    const count = typeof result.count === "number" ? result.count : 1;

    await this.log({
      model: params.model,
      recordId: 0, // Batch summary placeholder
      action: mapPrismaActionToAuditAction(params.action) ?? "UPDATE",
      newData: {
        batchOperation: true,
        count,
        args: deepClone(params.args),
      },
      metadata: { summary: true },
    });
  }

  /**
   * Extract the numeric primary key from a Prisma result object.
   */
  extractRecordId(record: Record<string, unknown>): number | null {
    const id = record.id ?? record.ID ?? record.Id;
    if (typeof id === "number") return id;
    if (typeof id === "string" && !Number.isNaN(Number(id))) return Number(id);
    return null;
  }
}
