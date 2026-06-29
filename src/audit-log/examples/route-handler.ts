// @ts-nocheck
// Example Next.js App Router Route Handler with automatic audit logging.

import { NextRequest, NextResponse } from "next/server";
import PrismaDB, { withAuditContext } from "@/lib/prisma";

export async function PUT(request: NextRequest, { params }: { params: { id: string } }) {
  return withAuditContext(request, 42)(async () => {
    const id = Number(params.id);
    const body = await request.json();

    const updatedUser = await PrismaDB.user.update({
      where: { id },
      data: body,
    });

    return NextResponse.json(updatedUser);
  });
}
