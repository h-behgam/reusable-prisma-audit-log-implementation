// @ts-nocheck
// Extended Prisma client with the AuditLogger extension wired in.
// Import this file in Route Handlers and Server Actions that need audit logging.

import PrismaBase from "./prisma-base";
import { createAuditExtension } from "@/audit-log/extension";

const PrismaDB = PrismaBase.$extends(
  createAuditExtension(PrismaBase, {
    // Replace values of these exact fields with "[REDACTED]" in old_data/new_data.
    sensitiveFields: ["password", "currentPassword", "confirmPassword", "passwordHash", "token", "secret", "creditCard"],

    // Completely remove these exact fields from old_data/new_data/batch args.
    // Use this when you never want the field name or value to appear in logs.
    omitFields: [],

    // Never audit these models.
    excludedModels: ["AuditLog", "Session", "VerificationToken"],

    onError: (error, entry) => {
      // Forward to your observability platform (Sentry, Datadog, etc.)
      console.error("[AuditLogger] write failed", error, entry);
    },
  })
);

export default PrismaDB;
export { withAuditContext } from "@/audit-log/extension";
