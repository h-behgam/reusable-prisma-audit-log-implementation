import type { AuditRequestContext, AuditUserResolver } from "./types";
import { extractRequestContext, getClientIp } from "./utils";

/**
 * Next.js helpers for the reusable AuditLogger.
 */

export function getAuditRequestContext(req: Request): AuditRequestContext {
  return extractRequestContext(req);
}

/**
 * Build a user resolver from a Next.js session/auth callback.
 *
 * Example with NextAuth:
 *
 *   const audit = new AuditLogger(prisma, {
 *     userId: nextAuthUserResolver(() => auth()),
 *     requestContext: getAuditRequestContext(request),
 *   });
 */
export function nextAuthUserResolver(
  authFn: () => Promise<{ user?: { id?: string | number } | null } | null>
): AuditUserResolver {
  return async () => {
    const session = await authFn();
    const id = session?.user?.id;
    if (id === undefined || id === null) return null;
    return typeof id === "string" ? Number(id) || null : id;
  };
}

/**
 * Extract client IP from Next.js headers object.
 */
export function getClientIpFromHeaders(headers: Headers): string | undefined {
  return getClientIp(new Request("http://localhost", { headers }));
}
