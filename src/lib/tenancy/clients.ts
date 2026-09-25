import { PrismaClient } from "@prisma/client";
import { tenancyState, type Tenant } from "@/lib/tenancy/state";

/**
 * One database client per workspace, kept while in use.
 *
 * A Prisma client is a connection pool plus a parsed copy of the schema, so there is one per
 * workspace, reused across requests — and a bounded number of them: the least recently used is
 * closed when there are too many, and any left idle for ten minutes is closed on the next use.
 *
 * Closing is delayed two minutes, longer than any transaction may run: a request that picked up a
 * client just before it was evicted finishes on it instead of failing mid-transaction.
 *
 * The only file (with the control plane's and the reference database's) allowed `new PrismaClient`
 * — check:tenancy.
 */

const MAX_CLIENTS = Math.max(2, Number(process.env.TENANCY_MAX_CLIENTS ?? 25));
const IDLE_MS = 10 * 60_000;
const CLOSE_DELAY_MS = 2 * 60_000;

/** A small pool per workspace, unless the URL already says: hundreds of workspaces share one server. */
function withPoolLimits(url: string): string {
  const limit = process.env.TENANCY_CONNECTION_LIMIT ?? "5";
  try {
    const u = new URL(url);
    if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
    if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "10");
    return u.toString();
  } catch {
    return url;
  }
}

function closeLater(client: PrismaClient) {
  const timer = setTimeout(() => {
    client.$disconnect().catch(() => {});
  }, CLOSE_DELAY_MS);
  timer.unref?.();
}

export function clientFor(tenant: Tenant): PrismaClient {
  const { clients } = tenancyState();
  const now = Date.now();
  const hit = clients.get(tenant.id);
  if (hit && hit.url === tenant.dbUrl) {
    hit.lastUsed = now;
    // Re-inserted, so iteration order is least-recently-used first.
    clients.delete(tenant.id);
    clients.set(tenant.id, hit);
    return hit.client;
  }
  if (hit) {
    // The workspace moved to another database: the old client goes, the new one comes.
    clients.delete(tenant.id);
    closeLater(hit.client);
  }

  for (const [id, entry] of clients) {
    if (now - entry.lastUsed > IDLE_MS) {
      clients.delete(id);
      closeLater(entry.client);
    }
  }
  while (clients.size >= MAX_CLIENTS) {
    const [oldest, entry] = clients.entries().next().value as [string, { client: PrismaClient }];
    clients.delete(oldest);
    closeLater(entry.client);
  }

  const client = new PrismaClient({ datasourceUrl: withPoolLimits(tenant.dbUrl) });
  clients.set(tenant.id, { client, url: tenant.dbUrl, lastUsed: now });
  return client;
}

/** For check scripts: close every client now, so a script can exit. */
export async function closeAllClients(): Promise<void> {
  const { clients } = tenancyState();
  const all = [...clients.values()];
  clients.clear();
  await Promise.all(all.map((e) => e.client.$disconnect().catch(() => {})));
}
