// @ts-nocheck
// This module is intended for Next.js backend usage with Prisma Driver
// Adapters. It uses Prisma Client Extensions (`$extends`) which are the
// recommended replacement for `$use` middleware when driver adapters are used.

import { auditContext } from "./context";
import { AuditLogger, type PrismaLikeClient } from "./service";
import type { AuditLoggerConfig } from "./types";

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
  const audit = new AuditLogger(prisma as PrismaLikeClient, {
    ...config,
    userId: () => auditContext.getUserId(),
    requestContext: auditContext.getRequestContext(),
    defaultMetadata: auditContext.getMetadata(),
  });

  const prismaAny = prisma as Record<string, any>;

  return prismaAny.$extends({
    query: {
      $allModels: {
        async create({ model, args, query }: any) {
          const result = await query(args);
          await audit.logCreate(model, result);
          return result;
        },
        async update({ model, args, query }: any) {
          const oldRecord = await prismaAny[model].findUnique({ where: args.where });
          const result = await query(args);
          await audit.logUpdate(model, oldRecord, result);
          return result;
        },
        async upsert({ model, args, query }: any) {
          const oldRecord = args.where
            ? await prismaAny[model].findUnique({ where: args.where })
            : undefined;
          const result = await query(args);
          await audit.logUpsert(model, oldRecord, result);
          return result;
        },
        async delete({ model, args, query }: any) {
          const oldRecord = await prismaAny[model].findUnique({ where: args.where });
          const result = await query(args);
          await audit.logDelete(model, oldRecord);
          return result;
        },
        async createMany({ model, args, query }: any) {
          const result = await query(args);
          await audit.logBatchSummary({ model, action: "createMany", args }, result);
          return result;
        },
        async updateMany({ model, args, query }: any) {
          const result = await query(args);
          await audit.logBatchSummary({ model, action: "updateMany", args }, result);
          return result;
        },
        async deleteMany({ model, args, query }: any) {
          const result = await query(args);
          await audit.logBatchSummary({ model, action: "deleteMany", args }, result);
          return result;
        },
      },
    },
  });
}

export { auditContext, withAuditContext } from "./context";
