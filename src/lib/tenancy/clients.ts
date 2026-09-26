import { PrismaClient } from "@prisma/client";
import { tenancyState, type ClientEntry, type Tenant } from "@/lib/tenancy/state";

/**
 * One database client per workspace, kept while in use.
 *
 * A Prisma client is a connection pool plus a parsed copy of the schema — tens of megabytes, and a
 * slow first query — so there is one per workspace, reused across requests, and a bounded number of
 * them: the least recently used idle one is closed when there are too many, and any left idle for
 * ten minutes is closed on the next use.
 *
 * An evicted client is closed the moment nothing is running on it, not later: with many workspaces
 * and a few kept, clients are evicted and reopened all the time, and one that lingers keeps its
 * connections and its memory — the 200-workspace load test ran the server out of connections that
 * way (docs/reports/load-test.md). What runs through `db` is counted (withClient), so a request that
 * picked up a client just before it was evicted still finishes on it, transaction and all. A client
 * handed out whole (getTenantDb) cannot be counted, so it is held for two minutes, longer than any
 * request, and that is also the backstop for everything else.
 *
 * The only file (with the control plane's and the reference database's) allowed `new PrismaClient`
 * — check:tenancy.
 */

const MAX_CLIENTS = Math.max(2, Number(process.env.TENANCY_MAX_CLIENTS?.trim() || 35));
const IDLE_MS = 10 * 60_000;
const HELD_MS = 2 * 60_000;

/**
 * The address the app's queries use: a small pool per workspace, unless the URL already says —
 * hundreds of workspaces share one server — and, with TENANCY_POOLER_URL set, through PgBouncer.
 *
 * A connection left unused for half a minute is closed (max_idle_connection_lifetime), so a workspace
 * that has gone quiet stops holding the server's connections while its client is still kept.
 *
 * The defaults — 35 clients, 2 connections each — keep the worst case, 70, within a stock Postgres's
 * 100 with room for everything else (docs/reports/load-test.md).
 *
 * Through the pooler, only the host and port change: the workspace's own role, password and
 * database stay, so PgBouncer keeps a pool per workspace and the role's limits still apply. It runs in
 * transaction mode, which Prisma needs told (`pgbouncer=true`: no prepared statements across
 * transactions). Migrations, backups and provisioning keep the direct address (tenant.dbUrl) —
 * they need a session of their own, which transaction pooling does not give.
 */
export function appUrl(url: string): string {
  const limit = process.env.TENANCY_CONNECTION_LIMIT?.trim() || "2";
  const idle = process.env.TENANCY_IDLE_CONNECTION_S?.trim() || "30";
  try {
    const u = new URL(url);
    const pooler = process.env.TENANCY_POOLER_URL?.trim();
    if (pooler) {
      const p = new URL(pooler);
      u.hostname = p.hostname;
      u.port = p.port;
      u.searchParams.set("pgbouncer", "true");
    }
    if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
    if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "10");
    if (!u.searchParams.has("max_idle_connection_lifetime")) u.searchParams.set("max_idle_connection_lifetime", idle);
    return u.toString();
  } catch {
    return url;
  }
}

function close(entry: ClientEntry) {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.backstop) clearTimeout(entry.backstop);
  entry.backstop = undefined;
  tenancyState().clientCounts.closed += 1;
  entry.client.$disconnect().catch(() => {});
}

/** Closes a retired client once nothing runs on it and nobody holds it. */
function closeWhenIdle(entry: ClientEntry) {
  if (entry.closed || entry.inFlight > 0) return;
  const wait = entry.heldUntil - Date.now();
  if (wait <= 0) return close(entry);
  if (entry.backstop) clearTimeout(entry.backstop);
  entry.backstop = setTimeout(() => close(entry), wait);
  entry.backstop.unref?.();
}

function retire(entry: ClientEntry) {
  entry.retired = true;
  if (entry.inFlight > 0) {
    // In case what runs on it never settles: closed after the hold, as before.
    entry.backstop = setTimeout(() => close(entry), HELD_MS);
    entry.backstop.unref?.();
    return;
  }
  closeWhenIdle(entry);
}

function entryFor(tenant: Tenant): ClientEntry {
  const { clients, clientCounts } = tenancyState();
  const now = Date.now();
  const hit = clients.get(tenant.id);
  if (hit && hit.url === tenant.dbUrl) {
    hit.lastUsed = now;
    // Re-inserted, so iteration order is least-recently-used first.
    clients.delete(tenant.id);
    clients.set(tenant.id, hit);
    return hit;
  }
  if (hit) {
    // The workspace moved to another database: the old client goes, the new one comes.
    clients.delete(tenant.id);
    retire(hit);
  }

  for (const [id, entry] of clients) {
    if (now - entry.lastUsed > IDLE_MS) {
      clients.delete(id);
      retire(entry);
    }
  }
  // Least recently used first, but never one with work running on it: evicting it frees nothing
  // until that work ends, and the same request's next query would open a second client for the
  // same workspace — with more workspaces busy than kept, that is all the process would do. So
  // while every kept client is busy the process goes over the cap, by at most the queries running
  // at once, and comes back under it as they finish.
  for (const [id, entry] of clients) {
    if (clients.size < MAX_CLIENTS) break;
    if (entry.inFlight > 0) continue;
    clients.delete(id);
    retire(entry);
  }

  const entry: ClientEntry = {
    client: new PrismaClient({ datasourceUrl: appUrl(tenant.dbUrl) }),
    url: tenant.dbUrl,
    lastUsed: now,
    inFlight: 0,
    heldUntil: 0,
    retired: false,
    closed: false,
  };
  clientCounts.opened += 1;
  clients.set(tenant.id, entry);
  return entry;
}

/**
 * The workspace's client, handed out whole — for a helper that takes a `PrismaClient`. Held, so it
 * is not closed under the caller for two minutes even if evicted meanwhile.
 */
export function clientFor(tenant: Tenant): PrismaClient {
  const entry = entryFor(tenant);
  entry.heldUntil = Math.max(entry.heldUntil, Date.now() + HELD_MS);
  return entry.client;
}

/** Runs `work` on the workspace's client, counted, so an evicted client closes as soon as it ends. */
export async function withClient<T>(tenant: Tenant, work: (client: PrismaClient) => Promise<T>): Promise<T> {
  const entry = entryFor(tenant);
  entry.inFlight += 1;
  try {
    return await work(entry.client);
  } finally {
    entry.inFlight -= 1;
    if (entry.retired) closeWhenIdle(entry);
  }
}

/** Clients kept now, and made and closed so far — for the load test and diagnostics. */
export function clientStats(): { kept: number; opened: number; closed: number; closing: number } {
  const { clients, clientCounts } = tenancyState();
  return { kept: clients.size, ...clientCounts, closing: clientCounts.opened - clientCounts.closed - clients.size };
}

/** For check scripts: close every client now, so a script can exit. */
export async function closeAllClients(): Promise<void> {
  const { clients, clientCounts } = tenancyState();
  const all = [...clients.values()];
  clients.clear();
  for (const entry of all) {
    entry.closed = true;
    if (entry.backstop) clearTimeout(entry.backstop);
    clientCounts.closed += 1;
  }
  await Promise.all(all.map((e) => e.client.$disconnect().catch(() => {})));
}
