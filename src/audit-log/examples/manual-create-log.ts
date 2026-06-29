// @ts-nocheck
// Example: manual audit logging after inserting data.
// Use this pattern when you want full control over the logged payload or
// when the automatic extension is disabled for a specific model.

import { NextRequest, NextResponse } from "next/server";
import PrismaDB from "@/lib/prisma";
import { AuditLogger, getAuditRequestContext } from "@/audit-log";

export async function POST(request: NextRequest) {
  const body = await request.json();

  // 1. Insert data into the database.
  const createdUser = await PrismaDB.user.create({
    data: {
      email: body.email,
      name: body.name,
      role: body.role ?? "USER",
      password: body.password, // hashed by your service layer
    },
  });

  // 2. Create an AuditLogger bound to the current request and user.
  const audit = new AuditLogger(PrismaDB, {
    userId: currentUser.id,
    requestContext: getAuditRequestContext(request),
    sensitiveFields: ["password"], // value will become "[REDACTED]"
  });

  // 3. Manually write the CREATE audit entry.
  await audit.log({
    model: "User",
    recordId: createdUser.id,
    action: "CREATE",
    oldData: null, // no previous record for a CREATE
    newData: createdUser,
    metadata: {
      source: "api",
      endpoint: "/api/users",
      reason: "User onboarding",
    },
  });

  return NextResponse.json(createdUser, { status: 201 });
}
