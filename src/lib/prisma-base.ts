// @ts-nocheck
// Base singleton Prisma client using the PostgreSQL Driver Adapter.
// This file intentionally does NOT register the AuditLogger extension so it
// can be imported in isolation (e.g. in seed scripts or tests).

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../../prisma/generated/client";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prismaClientSingleton = () => {
  return new PrismaClient({ adapter });
};

declare const globalThis: {
  prismaGlobal: ReturnType<typeof prismaClientSingleton>;
} & typeof global;

const PrismaBase = globalThis.prismaGlobal ?? prismaClientSingleton();

export default PrismaBase;

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = PrismaBase;
}
