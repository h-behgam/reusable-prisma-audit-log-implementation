// @ts-nocheck
// Example Next.js Server Action with automatic audit logging.

"use server";

import { revalidatePath } from "next/cache";
import PrismaDB, { withAuditContext } from "@/lib/prisma";

export async function updateCategory(formData: FormData) {
  // Server Actions don't have a native Request object. Build a minimal one
  // from the available headers, or use `headers()` from next/headers.
  const request = new Request("http://localhost", {
    headers: { "user-agent": "server-action" },
  });

  return withAuditContext(request, 42)(async () => {
    const id = Number(formData.get("id"));
    const name = String(formData.get("name") ?? "");

    const updated = await PrismaDB.category.update({
      where: { id },
      data: { name },
    });

    revalidatePath("/categories");
    return updated;
  });
}
