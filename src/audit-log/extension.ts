import { auditContext } from "./context";
import { AuditLogger } from "./service";
import type { AuditLoggerConfig } from "./types";

interface PrismaExtensionCallbackArgs {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
}

interface PrismaClientWithExtends {
  $extends: (extension: unknown) => unknown;
}

const WRITE_OPERATIONS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
];

/**
 * Build a Prisma Client Extension that automatically writes audit logs.
 *
 * This works with both standard PrismaClient and PrismaClient configured
 * with a Driver Adapter (`@prisma/adapter-pg`, `@prisma/adapter-libsql`, etc.).
 *
 * The extension reads userId, requestContext, and metadata from the
 * AsyncLocalStorage-backed `auditContext`. Wrap your handlers with
 * `withAuditContext()` or `auditContext.run()` for mutations to be attributed
 * correctly.
 */
export function createAuditExtension(
  prisma: unknown,
  config: Omit<AuditLoggerConfig, "userId" | "requestContext" | "defaultMetadata"> = {}
) {
  const audit = new AuditLogger(prisma, {
    ...config,
    userId: () => auditContext.getUserId(),
    requestContext: auditContext.getRequestContext(),
    defaultMetadata: auditContext.getMetadata(),
  });

  const prismaRecord = prisma as Record<string, unknown>;
  const prismaWithExtends = prisma as PrismaClientWithExtends;

  const findUnique = async (model: string, where: unknown): Promise<Record<string, unknown> | undefined> => {
    const delegate = prismaRecord[model];
    if (!delegate || typeof delegate !== "object") return undefined;

    const find = (delegate as Record<string, unknown>).findUnique as
      | ((args: { where: unknown }) => Promise<unknown>)
      | undefined;
    if (typeof find !== "function") return undefined;

    const record = await find({ where });
    return record ? (record as Record<string, unknown>) : undefined;
  };

  return prismaWithExtends.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: PrismaExtensionCallbackArgs) {
          if (!audit.shouldAuditModel(model)) return query(args);
          if (!WRITE_OPERATIONS.includes(operation)) return query(args);

          let oldRecord: Record<string, unknown> | undefined;

          if (operation === "update" || operation === "upsert" || operation === "delete") {
            oldRecord = await findUnique(model, args.where);
          }

          const result = await query(args);

          switch (operation) {
            case "create":
              await audit.logCreate(model, result as Record<string, unknown>);
              break;
            case "update":
              await audit.logUpdate(model, oldRecord, result as Record<string, unknown>);
              break;
            case "upsert":
              await audit.logUpsert(model, oldRecord, result as Record<string, unknown>);
              break;
            case "delete":
              await audit.logDelete(model, oldRecord);
              break;
            case "createMany":
            case "updateMany":
            case "deleteMany":
              await audit.logBatchSummary(
                { model, action: operation, args },
                result as Record<string, unknown>
              );
              break;
          }

          return result;
        },
      },
    },
  });
}

export { auditContext, withAuditContext } from "./context";
