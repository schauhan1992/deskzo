import { PrismaClient as ReferenceClient } from "@deskzo/reference-client";

export type { ReferenceClient };
export type { Prisma as ReferencePrisma } from "@deskzo/reference-client";

/**
 * The shared reference database's client — prisma/reference/schema.prisma, at REFERENCE_DATABASE_URL.
 *
 * India Post's PIN directory and GeoNames' world places, one copy for every workspace. Read from any
 * workspace (address forms, lookups); written only by its loaders and sync workers, which belong to
 * the platform rather than to a workspace (src/lib/platform/shared-data.ts).
 *
 * One per process, on `globalThis` like the others (src/lib/platform/control-db.ts).
 */
export function referenceConfigured(): boolean {
  return !!process.env.REFERENCE_DATABASE_URL?.trim();
}

export function refDb(): ReferenceClient {
  if (!referenceConfigured()) throw new Error("REFERENCE_DATABASE_URL is not set — see .env.example.");
  const g = globalThis as { [key: symbol]: ReferenceClient | undefined };
  const key = Symbol.for("deskzo.reference-db");
  if (!g[key]) g[key] = new ReferenceClient({ datasourceUrl: process.env.REFERENCE_DATABASE_URL });
  return g[key]!;
}

/** For scripts: close it, so the process can exit. */
export async function closeRefDb(): Promise<void> {
  const g = globalThis as { [key: symbol]: ReferenceClient | undefined };
  const key = Symbol.for("deskzo.reference-db");
  const client = g[key];
  g[key] = undefined;
  await client?.$disconnect().catch(() => {});
}
