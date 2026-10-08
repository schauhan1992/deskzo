import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@prisma/client";
import { poolSettings } from "@/lib/tenancy/direct-client";
import { tenancyState, type PoolEntry, type Tenant } from "@/lib/tenancy/state";

/**
 * Every workspace's queries, through one Prisma client.
 *
 * Each workspace has a database of its own. One Prisma client serves them all: it is given a routing
 * adapter (Prisma's driver-adapter interface) which, for each query, takes the workspace the work
 * runs as — `db` (src/lib/db.ts) runs every call as its workspace — and sends it to that workspace's
 * own small pool of connections. A transaction stays on the connection it began on.
 *
 * Why one: a Prisma client builds a query compiler from the whole schema, which takes tens of
 * milliseconds of the process's only thread. With a client per workspace, a server with more busy
 * workspaces than it kept clients for spent nearly all its time opening them (docs/reports/
 * load-test.md). A pool costs a few milliseconds, most of them waiting for the server.
 *
 * What makes sharing safe:
 *   · a query outside any workspace is refused, never sent to a default;
 *   · Prisma merges findUnique calls of the same shape made in the same tick into one query, run in
 *     the first caller's context — two workspaces' lookups would be answered from one database. Here
 *     that merging is confined to one transaction's queries (one caller's, by construction), and if
 *     Prisma's internals ever move, the client refuses to start rather than share unsafely.
 * check:hardening proves both, against two real databases.
 *
 * Pools: a bounded number kept (TENANCY_MAX_CLIENTS), the least recently used idle one ended first —
 * never one with work on it; one retired while work runs on it is ended the moment the work does.
 * A connection unused for TENANCY_IDLE_CONNECTION_S closes by itself, so a quiet workspace holds none.
 *
 * The only file (with direct-client.ts, the control plane's and the reference database's) allowed
 * `new PrismaClient` — check:tenancy.
 */

const MAX_POOLS = Math.max(2, Number(process.env.TENANCY_MAX_CLIENTS?.trim() || 35));
const IDLE_MS = 10 * 60_000;
/** Ended after this whatever it runs — a transaction that never ended must not hold a pool forever. */
const BACKSTOP_MS = 2 * 60_000;

/**
 * The address a workspace's pool connects to: the workspace's own, unless TENANCY_POOLER_URL sends
 * the app's queries through PgBouncer — then its host and port, with the workspace's own role,
 * password and database, so PgBouncer keeps a pool per workspace and the role's limits still apply.
 * node-postgres sends unnamed statements, which PgBouncer's transaction mode takes as they are.
 * Migrations, backups and provisioning keep the direct address (tenant.dbUrl): they need a session.
 *
 * The pool: TENANCY_CONNECTION_LIMIT connections (2), each closed after TENANCY_IDLE_CONNECTION_S
 * unused (30) — unless the address already says (connection_limit, max_idle_connection_lifetime).
 * The defaults, 35 pools of 2, keep the worst case, 70, within a stock Postgres's 100 with room for
 * everything else.
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
    }
    if (!u.searchParams.has("connection_limit")) u.searchParams.set("connection_limit", limit);
    if (!u.searchParams.has("pool_timeout")) u.searchParams.set("pool_timeout", "10");
    if (!u.searchParams.has("max_idle_connection_lifetime")) u.searchParams.set("max_idle_connection_lifetime", idle);
    return u.toString();
  } catch {
    return url;
  }
}

// ─── Pools ─────────────────────────────────────────────────────────────────────────────────────

function close(entry: PoolEntry) {
  if (entry.closed) return;
  entry.closed = true;
  if (entry.backstop) clearTimeout(entry.backstop);
  entry.backstop = undefined;
  tenancyState().poolCounts.closed += 1;
  // Ending a pool lets what is running on it finish; nothing new is sent to a retired one.
  entry.adapter.then((adapter) => adapter.dispose()).catch(() => {});
}

function retire(entry: PoolEntry) {
  entry.retired = true;
  if (entry.inFlight <= 0) return close(entry);
  entry.backstop = setTimeout(() => close(entry), BACKSTOP_MS);
  entry.backstop.unref?.();
}

function release(entry: PoolEntry) {
  entry.inFlight -= 1;
  if (entry.retired && entry.inFlight <= 0) close(entry);
}

function entryFor(tenant: Tenant): PoolEntry {
  const { pools, poolCounts } = tenancyState();
  const now = Date.now();
  const hit = pools.get(tenant.id);
  if (hit && hit.url === tenant.dbUrl) {
    hit.lastUsed = now;
    // Re-inserted, so iteration order is least-recently-used first.
    pools.delete(tenant.id);
    pools.set(tenant.id, hit);
    return hit;
  }
  if (hit) {
    // The workspace moved to another database: the old pool goes, the new one comes.
    pools.delete(tenant.id);
    retire(hit);
  }
  for (const [id, entry] of pools) {
    if (now - entry.lastUsed > IDLE_MS && entry.inFlight <= 0) {
      pools.delete(id);
      retire(entry);
    }
  }
  // Least recently used first, but never one with work running on it: ending it would not free its
  // connections until the work ends, and the same request's next query would open a second pool.
  // While every kept pool is busy the process goes over the cap, by at most the work running at
  // once, and comes back under it as that finishes.
  for (const [id, entry] of pools) {
    if (pools.size < MAX_POOLS) break;
    if (entry.inFlight > 0) continue;
    pools.delete(id);
    retire(entry);
  }

  const { pool, schema } = poolSettings(appUrl(tenant.dbUrl), { max: 2 });
  if (schema !== "public") throw new Error(`Workspace "${tenant.slug}" is not in the public schema — every workspace database is, and the shared client assumes it.`);
  const entry: PoolEntry = {
    adapter: new PrismaPg(pool, {
      schema,
      // A connection the server dropped while idle (a restart, a database closed): said, not thrown.
      onPoolError: (err) => console.warn(`[${tenant.slug}] an idle database connection was dropped: ${err.message}`),
    }).connect(),
    url: tenant.dbUrl,
    lastUsed: now,
    inFlight: 0,
    retired: false,
    closed: false,
  };
  poolCounts.opened += 1;
  pools.set(tenant.id, entry);
  return entry;
}

// ─── The routing adapter ───────────────────────────────────────────────────────────────────────

type PgAdapter = Awaited<PoolEntry["adapter"]>;
type Query = Parameters<PgAdapter["queryRaw"]>[0];
type Isolation = Parameters<PgAdapter["startTransaction"]>[0];

function current(): PoolEntry {
  const tenant = tenancyState().als.getStore();
  if (!tenant) throw new Error("A workspace query outside any workspace. Queries go through db (src/lib/db.ts), which runs each as its workspace.");
  return entryFor(tenant);
}

async function counted<T>(work: (adapter: PgAdapter) => Promise<T>): Promise<T> {
  const entry = current();
  entry.inFlight += 1;
  try {
    return await work(await entry.adapter);
  } finally {
    release(entry);
  }
}

const router = {
  provider: "postgres" as const,
  adapterName: "deskzo-workspaces",
  queryRaw: (query: Query) => counted((adapter) => adapter.queryRaw(query)),
  executeRaw: (query: Query) => counted((adapter) => adapter.executeRaw(query)),
  executeScript: (script: string) => counted((adapter) => adapter.executeScript(script)),
  /** On the workspace's pool, and counted on it until committed or rolled back. */
  async startTransaction(isolation?: Isolation) {
    const entry = current();
    entry.inFlight += 1;
    let tx: Awaited<ReturnType<PgAdapter["startTransaction"]>>;
    try {
      tx = await (await entry.adapter).startTransaction(isolation);
    } catch (err) {
      release(entry);
      throw err;
    }
    let open = true;
    const end = () => {
      if (!open) return;
      open = false;
      release(entry);
    };
    // One connection: its queries one after another, as the Rust engine ran them. Code that awaits
    // several at once inside a transaction (Promise.all over tx) otherwise hands node-postgres
    // overlapping queries on one client, which it warns about now and refuses from pg 9.
    let queue: Promise<unknown> = Promise.resolve();
    const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
      const turn = queue.then(work, work);
      queue = turn.catch(() => {});
      return turn;
    };
    return {
      provider: tx.provider,
      adapterName: tx.adapterName,
      options: tx.options,
      queryRaw: (query: Query) => inTurn(() => tx.queryRaw(query)),
      executeRaw: (query: Query) => inTurn(() => tx.executeRaw(query)),
      commit: async () => {
        try {
          await tx.commit();
        } finally {
          end();
        }
      },
      rollback: async () => {
        try {
          await tx.rollback();
        } finally {
          end();
        }
      },
    };
  },
  // The same for every workspace: each database is in the public schema (entryFor makes sure).
  getConnectionInfo: () => ({ schemaName: "public", supportsRelationJoins: true }),
  dispose: () => closeAllPools(),
};

const factory = { provider: "postgres" as const, adapterName: "deskzo-workspaces", connect: async () => router };

type Batcher = { _requestHandler?: { dataloader?: { options?: { batchBy?: unknown } } } };
type BatchedRequest = { transaction?: { id?: string | number } };

/**
 * Columns left out of every query that doesn't name them, until every workspace has them.
 *
 * A query without a `select` — a sign-in's lookup of the person, an update's RETURNING — lists every
 * column Prisma knows. A release serves before `tenants:migrate` has reached every workspace
 * (docs/deploy-coolify.md), so a column added to a busy table would fail those queries in each
 * workspace still waiting its turn: nobody there could sign in. A query that wants one of these
 * names it in its `select`, and is ready for the column not to be there yet. (The client is typed
 * as if nothing were left out; nothing reads these but by name.)
 *
 * Take an entry out in a later release, once every workspace is past the migration that added it.
 */
const NOT_YET_EVERYWHERE = {
  // 20261013100000_deskzo_updates_seen. Read by name in src/actions/help.ts only.
  user: { deskzoUpdatesSeenAt: true, reminderSounds: true },
  // 20261014100000_custom_fields. Read by name (`select` or `omit: { customFields: false }`) through
  // src/lib/custom-fields/server.ts, which treats a workspace without the column as having no values.
  company: { customFields: true },
  // and 20261029100000_contact_left, 20261029110000_designations_vendor_fields_reminders: read by name in
  // src/lib/contacts/left.ts, designations.ts and moves.ts. user.reminderSounds: src/actions/reminder-sounds.ts.
  contact: { customFields: true, leftAt: true, designationId: true, previousContactId: true },
  // 20261015100000_lead_pipeline. Read by name through src/lib/pipeline/server.ts and the lead actions.
  lead: { customFields: true, stageId: true, stageChangedAt: true },
  item: { customFields: true },
  // 20261016100000_order_steps. Read by name through src/lib/pipeline/order-steps-server.ts.
  companyProduct: { customFields: true, stepId: true, stepChangedAt: true },
  // 20261018100000_workplace_sign_in_and_mail. A Zoho mailbox's details are read by name in
  // src/lib/mail/mailbox.ts.
  mailConnection: { zohoAccountsServer: true, zohoMailAccountId: true },
  // 20261019100000_watermark_scope. The DLP policy is read on every page; read by name in
  // src/lib/security/store.ts.
  securityPolicy: { watermarkScope: true },
  // 20261028110000_bank_accounts_vendor_codes. Read by name in src/lib/companies/vendor-code.ts and
  // src/lib/banking/organisation-accounts.ts, which fall back when the column is not there yet.
  organisationSettings: { vendorCodePrefix: true },
  branch: { defaultBankAccountId: true },
  tradeDocument: { bankAccountId: true },
} satisfies Prisma.GlobalOmitConfig;

/** The one client, made on first use. */
export function sharedClient(): PrismaClient {
  const state = tenancyState();
  if (state.shared) return state.shared;
  const client = new PrismaClient({ adapter: factory as unknown as Prisma.PrismaClientOptions["adapter"], omit: NOT_YET_EVERYWHERE }) as unknown as PrismaClient;
  // Same-tick findUnique calls are merged only within one transaction — see the top of this file.
  const options = (client as unknown as Batcher)._requestHandler?.dataloader?.options;
  if (!options || typeof options.batchBy !== "function") {
    throw new Error("Prisma's request batching is not where src/lib/tenancy/clients.ts expects it — refusing to share one client between workspaces. Check after upgrading Prisma.");
  }
  options.batchBy = (request: BatchedRequest) => (request.transaction?.id ? `transaction-${request.transaction.id}` : undefined);
  state.shared = client;
  return client;
}

/**
 * Runs `work` as the workspace, on the shared client, with the workspace's pool counted as busy
 * throughout — so it is not ended between two of the work's queries. What `work` returns is awaited
 * here, inside: a Prisma query is lazy and runs where it is awaited.
 */
export async function withClient<T>(tenant: Tenant, work: (client: PrismaClient) => PromiseLike<T>): Promise<T> {
  const entry = entryFor(tenant);
  entry.inFlight += 1;
  try {
    return await tenancyState().als.run(tenant, async () => await work(sharedClient()));
  } finally {
    release(entry);
  }
}

/**
 * The client as one workspace's — for a helper that takes a `PrismaClient`. Every call on it runs as
 * that workspace, wherever it is made; closing it closes nothing (the client is everybody's).
 */
export function clientFor(tenant: Tenant): PrismaClient {
  const shared = sharedClient();
  const run = (fn: (...args: unknown[]) => unknown, self: unknown, args: unknown[]) => withClient(tenant, async () => await (fn.apply(self, args) as PromiseLike<unknown>));
  return new Proxy(shared, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof prop !== "string") return value;
      if (prop === "then") return undefined;
      if (prop === "$disconnect" || prop === "$connect") return async () => {};
      if (typeof value === "function") return (...args: unknown[]) => run(value as (...a: unknown[]) => unknown, target, args);
      if (value && typeof value === "object" && !prop.startsWith("$") && !prop.startsWith("_")) {
        // A model: each of its operations runs as the workspace.
        return new Proxy(value as object, {
          get(delegate, method) {
            const fn = Reflect.get(delegate, method);
            return typeof fn === "function" ? (...args: unknown[]) => run(fn as (...a: unknown[]) => unknown, delegate, args) : fn;
          },
        });
      }
      return value;
    },
  });
}

/** Pools kept now, and opened and ended so far — for the load test and diagnostics. */
export function clientStats(): { kept: number; opened: number; closed: number; closing: number } {
  const { pools, poolCounts } = tenancyState();
  return { kept: pools.size, ...poolCounts, closing: poolCounts.opened - poolCounts.closed - pools.size };
}

async function closeAllPools(): Promise<void> {
  const { pools, poolCounts } = tenancyState();
  const all = [...pools.values()];
  pools.clear();
  await Promise.all(
    all.map(async (entry) => {
      if (entry.closed) return;
      entry.closed = true;
      if (entry.backstop) clearTimeout(entry.backstop);
      poolCounts.closed += 1;
      await (await entry.adapter).dispose().catch(() => {});
    }),
  );
}

/** For scripts and check suites: end every workspace's pool now, so the process can exit. */
export async function closeAllClients(): Promise<void> {
  await closeAllPools();
}
