import type { AuditLoggerConfig, AuditMetadata, AuditUserResolver } from "./types";

/**
 * Fluent builder for AuditLogger configuration.
 *
 * Example:
 *
 *   const config = new AuditConfigBuilder()
 *     .withUser(() => getCurrentUserId())
 *     .withRequestContext(getAuditRequestContext(request))
 *     .redactFields("password", "token")
 *     .excludeModels("AuditLog", "Session")
 *     .withDefaultMetadata({ tenantId: 1 })
 *     .build();
 */
export class AuditConfigBuilder {
  private config: AuditLoggerConfig = {};

  withUser(userId: number | null | AuditUserResolver): this {
    this.config.userId = userId;
    return this;
  }

  withRequestContext(context: NonNullable<AuditLoggerConfig["requestContext"]>): this {
    this.config.requestContext = context;
    return this;
  }

  redactFields(...fields: string[]): this {
    this.config.sensitiveFields = fields;
    return this;
  }

  omitFields(...fields: string[]): this {
    this.config.omitFields = fields;
    return this;
  }

  includeModels(...models: string[]): this {
    this.config.includedModels = models;
    return this;
  }

  excludeModels(...models: string[]): this {
    this.config.excludedModels = models;
    return this;
  }

  logBatchOperations(enabled: boolean): this {
    this.config.logBatchOperations = enabled;
    return this;
  }

  withDefaultMetadata(metadata: AuditMetadata): this {
    this.config.defaultMetadata = metadata;
    return this;
  }

  onError(handler: NonNullable<AuditLoggerConfig["onError"]>): this {
    this.config.onError = handler;
    return this;
  }

  build(): AuditLoggerConfig {
    return { ...this.config };
  }
}
