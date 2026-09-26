import { AsyncLocalStorage } from "node:async_hooks";
import type { PrismaClient } from "@prisma/client";
import type { Entitlements } from "@/lib/entitlements";

/**
 * A workspace — one customer of the SaaS, with its own database.
 *
 * `id` is what everything per-workspace is keyed by: caches, lockouts, signing. For a workspace in
 * the control plane it is the control plane's id; for one read from the environment (before the
 * first workspace is adopted, and in check suites) it is the slug.
 */
export type Tenant = {
  id: string;
  slug: string;
  name: string;
  status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "MIGRATING" | "DEPROVISIONED";
  /** The database. Never shown, never logged. */
  dbUrl: string;
  /** The address links in emails and documents are built on, e.g. "acme.example.com". */
  primaryHost: string;
  /** Every host that reaches it: its subdomain, custom domains, an old address kept alive. */
  hosts: string[];
  /** Where it was found: the control plane, or the environment (src/lib/tenancy/registry.ts). */
  source: "control" | "env";
  /** The first workspace, adopted from the installation that came before — what scripts act as. */
  isDefault: boolean;
  /** Its key bundle, sealed under the platform key. Null for a workspace from the environment. */
  keyBundleCipher: string | null;
  /** ISO 3166-1 alpha-2 — which country-bound modules and features it may have. */
  country: string;
  /** What its plans let it use (src/lib/entitlements.ts). Everything, for one from the environment. */
  entitlements: Entitlements;
  /** Why it is held, when SUSPENDED: by staff, or for billing — which leaves its billing page open. */
  holdReason: "STAFF" | "BILLING" | null;
};

export type ClientEntry = {
  client: PrismaClient;
  url: string;
  lastUsed: number;
  /** Queries (or transactions) running on it now, through `db`. */
  inFlight: number;
  /** Handed out whole (getTenantDb) — not closed before this, whatever inFlight says. */
  heldUntil: number;
  /** Evicted: closed as soon as nothing is running on it. */
  retired: boolean;
  closed: boolean;
  backstop?: ReturnType<typeof setTimeout>;
};

type TenancyState = {
  /** The workspace a piece of work is for, where there is no request to say so. */
  als: AsyncLocalStorage<Tenant>;
  /** host → tenant (or a known miss), with when it was looked up. */
  registry: Map<string, { tenant: Tenant | null; at: number }>;
  /** One database client per workspace, least recently used first out. */
  clients: Map<string, ClientEntry>;
  /** Clients made and closed since the process started — for the load test and diagnostics. */
  clientCounts: { opened: number; closed: number };
  /** Each workspace's opened key bundle, briefly (src/lib/tenancy/keys.ts). */
  keys: Map<string, { cipher: string | null; keys: unknown; at: number }>;
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
  if (!g[key]) g[key] = { als: new AsyncLocalStorage<Tenant>(), registry: new Map(), clients: new Map(), clientCounts: { opened: 0, closed: 0 }, keys: new Map() };
  // A process that loaded an older copy of this module (a dev server across a hot reload).
  g[key]!.keys ??= new Map();
  g[key]!.clientCounts ??= { opened: 0, closed: 0 };
  return g[key]!;
}
