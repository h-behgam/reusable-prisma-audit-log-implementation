/**
 * Minimal JSON value types. These are compatible with Prisma's InputJsonValue
 * but defined locally so the package compiles before `prisma generate` is run.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

/**
 * Supported audit actions.
 */
export type AuditAction = "CREATE" | "UPDATE" | "DELETE" | "UPSERT";

/**
 * Parameters passed to a Prisma middleware.
 */
export interface PrismaMiddlewareParams {
  model?: string;
  action: string;
  args: Record<string, unknown>;
}

/**
 * Context extracted from an incoming request.
 */
export interface AuditRequestContext {
  ipAddress?: string;
  userAgent?: string;
  requestPath?: string;
  requestMethod?: string;
}

/**
 * Extra metadata that can be attached to an audit entry.
 */
export type AuditMetadata = Record<string, unknown>;

/**
 * User identifier provider. Allows passing a static id or a resolver function
 * so the logger can run in contexts where the user is not yet known.
 */
export type AuditUserResolver = () => Promise<number | null> | number | null;

/**
 * Shape of the data we store in the AuditLog table.
 */
export interface AuditEntry {
  userId: number | null;
  model: string;
  recordId: number;
  action: AuditAction;
  oldData: JsonValue | null;
  newData: JsonValue | null;
  changedFields: string[] | null;
  ipAddress: string | null;
  userAgent: string | null;
  requestPath: string | null;
  requestMethod: string | null;
  metadata: JsonValue | null;
}

/**
 * Raw log input accepted by the public API.
 */
export interface CreateAuditLogInput {
  model: string;
  recordId: number;
  action: AuditAction;
  oldData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
  changedFields?: string[];
  metadata?: AuditMetadata;
}

/**
 * Configuration for the automatic Prisma middleware.
 */
export interface AuditMiddlewareConfig {
  /**
   * Prisma models that should be audited. If omitted, all models are audited
   * except those in `excludedModels`.
   */
  includedModels?: string[];

  /**
   * Prisma models that should never be audited (e.g. AuditLog itself, sessions).
   */
  excludedModels?: string[];

  /**
   * Fields whose values should be replaced with "[REDACTED]" in both oldData
   * and newData snapshots. Case-insensitive matching.
   */
  sensitiveFields?: string[];

  /**
   * Fields that should be completely removed from both oldData and newData
   * snapshots. Use this when you never want the field name or value to appear
   * in the audit log (e.g. passwords, raw tokens).
   */
  omitFields?: string[];

  /**
   * When true, batch operations (createMany/updateMany/deleteMany) emit one
   * audit log per affected record. When false, they are skipped automatically.
   */
  logBatchOperations?: boolean;
}

/**
 * Complete configuration for AuditLogger.
 */
export interface AuditLoggerConfig extends AuditMiddlewareConfig {
  /**
   * A function or static value identifying the acting user.
   */
  userId?: number | null | AuditUserResolver;

  /**
   * Request context (IP, user agent, path, method).
   */
  requestContext?: AuditRequestContext;

  /**
   * Default metadata merged into every audit entry.
   */
  defaultMetadata?: AuditMetadata;

  /**
   * Optional callback invoked on every audit write failure.
   */
  onError?: (error: Error, entry: Partial<AuditEntry>) => void;
}

/**
 * Diff result produced by the internal diff utility.
 */
export interface ObjectDiffResult {
  changedFields: string[];
  oldData: Record<string, unknown>;
  newData: Record<string, unknown>;
}
