import { PrismaClient as ControlClient } from "@deskzo/control-client";

export type { ControlClient };

/**
 * The control plane's database client — prisma/control/schema.prisma, at CONTROL_DATABASE_URL.
 *
 * One per process, on `globalThis` for the same reason as the workspace clients (src/lib/tenancy/
 * state.ts): proxy.ts is bundled apart from the routes, and both must share it.
 *
 * Unset CONTROL_DATABASE_URL means an installation from before workspaces, or a check suite: the
 * registry then reads the environment instead (src/lib/tenancy/registry.ts).
 */
export function controlConfigured(): boolean {
  return !!process.env.CONTROL_DATABASE_URL?.trim();
}

export function controlDb(): ControlClient {
  if (!controlConfigured()) throw new Error("CONTROL_DATABASE_URL is not set.");
  const g = globalThis as { [key: symbol]: ControlClient | undefined };
  const key = Symbol.for("deskzo.control-db");
  if (!g[key]) g[key] = new ControlClient({ datasourceUrl: process.env.CONTROL_DATABASE_URL });
  return g[key]!;
}

/** For scripts: close it, so the process can exit. */
export async function closeControlDb(): Promise<void> {
  const g = globalThis as { [key: symbol]: ControlClient | undefined };
  const key = Symbol.for("deskzo.control-db");
  const client = g[key];
  g[key] = undefined;
  await client?.$disconnect().catch(() => {});
}
