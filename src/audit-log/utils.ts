import type {
  AuditAction,
  AuditMetadata,
  AuditRequestContext,
  JsonObject,
  JsonValue,
  ObjectDiffResult,
} from "./types";

/**
 * Deep clone a JSON-compatible value.
 */
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursively redact sensitive fields from a JSON value.
 * Matching is case-insensitive and applies to nested objects and arrays.
 */
export function redactSensitiveFields(
  data: unknown,
  sensitiveFields: string[]
): JsonValue | null {
  if (data === null || data === undefined) return null;

  if (Array.isArray(data)) {
    return data
      .map((item) => redactSensitiveFields(item, sensitiveFields))
      .filter((item): item is JsonValue => item !== null);
  }

  if (isJsonObject(data)) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(data)) {
      const isSensitive = sensitiveFields.some(
        (field) => field.toLowerCase() === key.toLowerCase()
      );
      result[key] = isSensitive ? "[REDACTED]" : redactSensitiveFields(value, sensitiveFields);
    }
    return result;
  }

  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return data;
  }

  return null;
}

/**
 * Compute a deep diff between two objects and return the changed field names
 * plus the shallow/old/new snapshots.
 */
export function diffObjects(
  oldData: Record<string, unknown> | null | undefined,
  newData: Record<string, unknown> | null | undefined
): ObjectDiffResult {
  const oldNormalized = oldData ?? {};
  const newNormalized = newData ?? {};

  const allKeys = new Set([
    ...Object.keys(oldNormalized),
    ...Object.keys(newNormalized),
  ]);

  const changedFields: string[] = [];
  const oldDiff: Record<string, unknown> = {};
  const newDiff: Record<string, unknown> = {};

  for (const key of allKeys) {
    const oldValue = oldNormalized[key];
    const newValue = newNormalized[key];

    if (!isEqual(oldValue, newValue)) {
      changedFields.push(key);
      oldDiff[key] = oldValue;
      newDiff[key] = newValue;
    }
  }

  return {
    changedFields,
    oldData: oldDiff,
    newData: newDiff,
  };
}

/**
 * Deep equality check for JSON-compatible values.
 */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((item, index) => isEqual(item, b[index]));
    }

    const keysA = Object.keys(a as object);
    const keysB = Object.keys(b as object);
    if (keysA.length !== keysB.length) return false;

    return keysA.every(
      (key) => keysB.includes(key) && isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    );
  }

  return false;
}

/**
 * Map Prisma action names to audit actions.
 */
export function mapPrismaActionToAuditAction(
  prismaAction: string
): AuditAction | null {
  switch (prismaAction) {
    case "create":
    case "createMany":
      return "CREATE";
    case "update":
    case "updateMany":
      return "UPDATE";
    case "upsert":
      return "UPSERT";
    case "delete":
    case "deleteMany":
      return "DELETE";
    default:
      return null;
  }
}

/**
 * Merge user-provided metadata with default metadata.
 */
export function mergeMetadata(
  defaultMetadata: AuditMetadata | undefined,
  metadata: AuditMetadata | undefined
): AuditMetadata | undefined {
  if (!defaultMetadata && !metadata) return undefined;
  return { ...defaultMetadata, ...metadata };
}

/**
 * Extract request context from a Web-standard Request object.
 */
export function extractRequestContext(req: Request): AuditRequestContext {
  return {
    ipAddress: getClientIp(req),
    userAgent: req.headers.get("user-agent") ?? undefined,
    requestPath: new URL(req.url).pathname,
    requestMethod: req.method,
  };
}

/**
 * Best-effort client IP extraction. Handles common proxies and Next.js headers.
 */
export function getClientIp(req: Request): string | undefined {
  const headers = req.headers;

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim();
  }

  const realIp = headers.get("x-real-ip");
  if (realIp) return realIp;

  // For Next.js deployments behind Vercel
  const vercelForwarded = headers.get("x-vercel-forwarded-for");
  if (vercelForwarded) {
    return vercelForwarded.split(",")[0]?.trim();
  }

  return undefined;
}

