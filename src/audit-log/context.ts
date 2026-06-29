// @ts-nocheck
// This module uses Node.js `async_hooks` and is intended for Next.js backend
// usage only. Do not import it into browser bundles.

import { AsyncLocalStorage } from "async_hooks";
import type { AuditMetadata, AuditRequestContext } from "./types";
import { extractRequestContext } from "./utils";

/**
 * Request-scoped audit context stored in AsyncLocalStorage.
 */
export interface AuditContextValue {
  userId?: number | null;
  requestContext?: AuditRequestContext;
  metadata?: AuditMetadata;
}

export class AuditContext {
  private storage = new AsyncLocalStorage<AuditContextValue>();

  /**
   * Run a callback with the given audit context. Works for both sync and
   * async callbacks because AsyncLocalStorage.run returns the callback result
   * as-is.
   */
  run<T>(value: AuditContextValue, callback: () => T): T {
    return this.storage.run(value, callback);
  }

  getStore(): AuditContextValue | undefined {
    return this.storage.getStore();
  }

  getUserId(): number | null {
    return this.getStore()?.userId ?? null;
  }

  getRequestContext(): AuditRequestContext | undefined {
    return this.getStore()?.requestContext;
  }

  getMetadata(): AuditMetadata | undefined {
    return this.getStore()?.metadata;
  }
}

/**
 * Singleton audit context. Use this to wrap Route Handlers and Server Actions.
 */
export const auditContext = new AuditContext();

/**
 * Convenience helper to wrap a function with audit context.
 */
export function withAuditContext(
  request: Request,
  userId?: number | null,
  metadata?: AuditMetadata
) {
  const requestContext = extractRequestContext(request);

  return <T>(callback: () => Promise<T>): Promise<T> => {
    return auditContext.run({ userId, requestContext, metadata }, callback);
  };
}
