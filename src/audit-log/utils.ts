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

function normalizeJsonValue(value: unknown): JsonValue | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJsonValue(item)).filter((item): item is JsonValue => item !== null);
  }
  if (isJsonObject(value)) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = normalizeJsonValue(item);
      if (normalized !== null) result[key] = normalized;
    }
    return result;
  }
  return null;
}

function fieldNameMatches(fieldName: string, patterns: string[]): boolean {
  const lowerKey = fieldName.toLowerCase();
  return patterns.some((pattern) => lowerKey === pattern.toLowerCase());
}

/**
 * Recursively redact sensitive fields from a JSON value.
 * Matching is exact and case-insensitive, so "password" only matches a field
 * literally named "password" (or "Password", "PASSWORD").
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
      const isSensitive = fieldNameMatches(key, sensitiveFields);
      result[key] = isSensitive ? "[REDACTED]" : redactSensitiveFields(value, sensitiveFields);
    }
    return result;
  }

  return normalizeJsonValue(data);
}

/**
 * Recursively remove specified fields from a JSON value.
 * Matching is exact and case-insensitive.
 */
export function omitFields(data: unknown, omitFieldsList: string[]): JsonValue | null {
  if (data === null || data === undefined) return null;

  if (Array.isArray(data)) {
    return data
      .map((item) => omitFields(item, omitFieldsList))
      .filter((item): item is JsonValue => item !== null);
  }

  if (isJsonObject(data)) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(data)) {
      if (fieldNameMatches(key, omitFieldsList)) continue;
      result[key] = omitFields(value, omitFieldsList);
    }
    return result;
  }

  return normalizeJsonValue(data);
}

/**
 * Remove top-level null/undefined entries from a snapshot object.
 */
export function compactSnapshot(
  data: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!data) return data;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Compute a deep diff between two objects and return the changed field names
 * plus the shallow/old/new snapshots. Missing fields in the new snapshot are
 * represented as `null` so they survive JSON serialization.
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
      oldDiff[key] = oldValue === undefined ? null : oldValue;
      newDiff[key] = newValue === undefined ? null : newValue;
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
 * null and undefined are treated as equal so that fields that are absent in
 * the new payload do not appear as changes when they were already null.
 */
export function isEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
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
