import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";

/**
 * A workspace — one customer of the SaaS, with its own database.
 *
 * `id` is what everything per-workspace is keyed by: caches, lockouts, signing. In M1 the registry
 * is static and the id is the slug; from M2 it is the control plane's own id.
 */
export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | "MIGRATING";
  /** The database. Never shown, never logged. */
  dbUrl: string;
  /** The address links in emails and documents are built on, e.g. "acme.example.com". */
  primaryHost: string;
  /** Every host that reaches it: its subdomain, custom domains, an old address kept alive. */
  hosts: string[];
};

export type ClientEntry = { client: PrismaClient; url: string; lastUsed: number };

type TenancyState = {
  /** The workspace a piece of work is for, where there is no request to say so. */
  als: AsyncLocalStorage<Tenant>;
  /** host → tenant (or a known miss), with when it was looked up. */
  registry: Map<string, { tenant: Tenant | null; at: number }>;
  /** One database client per workspace, least recently used first out. */
  clients: Map<string, ClientEntry>;
};

/**
 * Process-wide tenancy state, on `globalThis` rather than in module scope.
 *
 * `proxy.ts` is bundled separately from the app's routes, so a module-level Map here would exist
 * twice in one process — two sets of database clients per workspace, and a cache the proxy fills
 * that the pages never see. A well-known symbol on `globalThis` is the one place both halves share.
 * It also survives the dev server's hot reloads, as the single Prisma client used to.
 */
export function tenancyState(): TenancyState {
  const g = globalThis as { [key: symbol]: TenancyState | undefined };
  const key = Symbol.for("wroffy.tenancy");
  if (!g[key]) g[key] = { als: new AsyncLocalStorage<Tenant>(), registry: new Map(), clients: new Map() };
  return g[key]!;
}
