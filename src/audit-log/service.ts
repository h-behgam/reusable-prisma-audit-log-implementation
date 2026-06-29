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
  deepClone,
  diffObjects,
  mapPrismaActionToAuditAction,
  mergeMetadata,
  redactSensitiveFields,
} from "./utils";

/**
 * Generic Prisma-like client shape required by AuditLogger.
 *
 * We deliberately avoid importing the generated Prisma client so this package
 * stays reusable across projects and across Prisma versions. The signatures
 * are intentionally permissive so that extended Prisma clients (`$extends`)
 * and Driver Adapter clients are accepted without structural type conflicts.
 */
export interface PrismaLikeClient {
  auditLog: {
    create: (...args: unknown[]) => Promise<unknown>;
    createMany?: (...args: unknown[]) => Promise<unknown>;
  };
  [key: string]: unknown;
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

  constructor(
    private readonly prisma: PrismaLikeClient,
    private readonly config: AuditLoggerConfig = {}
  ) {
    this.userIdResolver =
      typeof config.userId === "function"
        ? config.userId
        : () => (config.userId as number | null | undefined) ?? null;
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
   * redaction, and diff calculation.
   */
  private async buildEntry(input: CreateAuditLogInput): Promise<AuditEntry> {
    const userId = await this.userIdResolver();
    const requestContext = this.config.requestContext ?? {};

    const oldData = input.oldData ?? {};
    const newData = input.newData ?? {};

    const redactedOld = redactSensitiveFields(
      oldData,
      this.config.sensitiveFields ?? []
    ) as Record<string, unknown> | null;

    const redactedNew = redactSensitiveFields(
      newData,
      this.config.sensitiveFields ?? []
    ) as Record<string, unknown> | null;

    let changedFields: string[] | undefined;
    let finalOldData: Record<string, unknown> | null = redactedOld;
    let finalNewData: Record<string, unknown> | null = redactedNew;

    if (input.action === "UPDATE" || input.action === "UPSERT") {
      const diff = diffObjects(redactedOld, redactedNew);
      changedFields =
        input.changedFields ?? (diff.changedFields.length > 0 ? diff.changedFields : undefined);

      // For updates, store only the changed fields to keep snapshots small.
      if (input.action === "UPDATE") {
        finalOldData = diff.oldData;
        finalNewData = diff.newData;
      }
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
      await this.prisma.auditLog.create({ data: entry });
    } catch (error) {
      this.handleError(error as Error, entry);
    }
  }

  private async persistMany(entries: AuditEntry[]): Promise<void> {
    try {
      if (this.prisma.auditLog.createMany) {
        await this.prisma.auditLog.createMany({ data: entries, skipDuplicates: true });
      } else {
        for (const entry of entries) {
          await this.prisma.auditLog.create({ data: entry });
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
  private shouldAuditModel(model: string | undefined): boolean {
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const delegate = (this.prisma as any)[model];
      if (!delegate || typeof delegate.findUnique !== "function") return undefined;

      const record = await delegate.findUnique({ where });
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
