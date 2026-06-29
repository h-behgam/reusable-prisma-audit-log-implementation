// @ts-nocheck
// The singleton Prisma client setup for this project is now split into:
//
//   src/lib/prisma-base.ts  → base PrismaClient with the pg driver adapter
//   src/lib/prisma.ts       → PrismaDB extended with the AuditLogger extension
//
// AuditLogger helpers are imported from:
//
//   import { createAuditExtension, withAuditContext } from "@/audit-log/extension";
//
// Usage in Route Handlers / Server Actions:
//
//   import PrismaDB, { withAuditContext } from "@/lib/prisma";
//
//   export async function PUT(request: NextRequest) {
//     return withAuditContext(request, currentUser.id)(async () => {
//       const updated = await PrismaDB.user.update({ ... });
//       return NextResponse.json(updated);
//     });
//   }
