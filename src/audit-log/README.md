# Reusable AuditLog for Next.js + Prisma

A framework-agnostic, model-agnostic audit logging service with first-class
Next.js helpers. Supports both the legacy Prisma middleware API (`$use`) and the
modern Prisma Client Extensions API (`$extends`) required by Driver Adapters
such as `@prisma/adapter-pg`.

## Features

- **Reusable**: Drop into any Prisma project without changing business models.
- **Driver Adapter compatible**: Uses `$extends` + AsyncLocalStorage instead of
  the unsupported `$use` middleware.
- **Generic Prisma client interface**: Works with the generated `PrismaClient`
  and any custom wrapper.
- **Automatic logging** via Prisma Client Extension (`create`, `update`, `upsert`,
  `delete`, batch operations).
- **Manual logging** API for explicit control and extra metadata.
- **Diff engine**: Computes `changedFields` automatically for `UPDATE`/`UPSERT`.
- **PII redaction**: Configurable field redaction across all snapshots.
- **Request context**: Captures IP, user agent, path, and HTTP method.
- **Batch summaries**: Best-effort logging for `createMany`/`updateMany`/`deleteMany`.
- **Error isolation**: Audit write failures never break business operations.

## Quick Start

### 1. Add the model to `prisma/schema.prisma`

Copy the `AuditLog` model from `prisma/schema.prisma` in this repo into your own
schema, then run:

```bash
npx prisma migrate dev --name add_audit_log
npx prisma generate
```

### 2. Wire the logger with Prisma Client Extensions

When using Driver Adapters (`@prisma/adapter-pg`), `$use` is **not available**.
Use `$extends` together with `withAuditContext`:

```ts
// lib/prisma.ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../prisma/generated/client";
import { createAuditExtension, withAuditContext } from "@/audit-log/extension";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const basePrisma = new PrismaClient({ adapter });

const PrismaDB = basePrisma.$extends(
  createAuditExtension(basePrisma, {
    sensitiveFields: ["password", "token", "secret"],
    excludedModels: ["AuditLog", "Session"],
  })
);

export default PrismaDB;
export { withAuditContext };
```

### 3. Wrap your handlers

```ts
import { NextRequest, NextResponse } from "next/server";
import PrismaDB, { withAuditContext } from "@/lib/prisma";

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return withAuditContext(request, currentUser.id)(async () => {
    const updated = await PrismaDB.user.update({
      where: { id: Number(params.id) },
      data: await request.json(),
    });
    return NextResponse.json(updated);
  });
}
```

### 4. Log manually when needed

```ts
import { AuditLogger, getAuditRequestContext } from "@/audit-log";

const audit = new AuditLogger(PrismaDB, {
  userId: currentUser.id,
  requestContext: getAuditRequestContext(request),
});

await audit.log({
  model: "Order",
  recordId: order.id,
  action: "UPDATE",
  oldData: previousOrder,
  newData: updatedOrder,
  metadata: { reason: "Customer request" },
});
```

## Legacy middleware (not for Driver Adapters)

If you are on a standard PrismaClient without a Driver Adapter, you can still use
`$use`:

```ts
const audit = new AuditLogger(prisma, { ... });
prisma.$use(audit.createMiddleware());
```

## Best Practices

- Use a singleton `PrismaClient` and apply the audit extension once.
- Always wrap request handlers with `withAuditContext()` so mutations are
  attributed to the right user and request.
- Exclude high-volume or sensitive models like `AuditLog`, `Session`, and
  `PasswordResetToken`.
- Add database partitioning or TTL archiving on `audit_logs` once it grows.
- Never block the user-facing response waiting for audit writes; rely on
  `onError` callbacks for observability.
