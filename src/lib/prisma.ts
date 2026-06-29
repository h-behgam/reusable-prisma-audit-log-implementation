// @ts-nocheck
// Extended Prisma client with the AuditLogger extension wired in.
// Import this file in Route Handlers and Server Actions that need audit logging.

import PrismaBase from "./prisma-base";
import { createAuditExtension } from "@/audit-log/extension";

const PrismaDB = PrismaBase.$extends(
  createAuditExtension(PrismaBase, {
    sensitiveFields: ["password", "passwordHash", "token", "secret", "creditCard"],
    excludedModels: ["AuditLog", "Session", "VerificationToken"],
    onError: (error, entry) => {
      // Forward to your observability platform (Sentry, Datadog, etc.)
      console.error("[AuditLogger] write failed", error, entry);
    },
  })
);

export default PrismaDB;
export { withAuditContext } from "@/audit-log/extension";
