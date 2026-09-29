import { SUPPORT_READONLY_ROLE } from "@/lib/roles";
import type { Prisma, PrismaClient } from "@prisma/client";
import { clientFor, closeAllClients, withClient } from "@/lib/tenancy/clients";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * The database — the current workspace's.
 *
 * Every workspace has a database of its own. `db` looks and types like the one Prisma client the
 * app always had, and every call on it first finds the workspace the work is for (see
 * src/lib/tenancy/resolve.ts), then runs as that workspace — on the one client every workspace
 * shares, which sends it to that workspace's database (src/lib/tenancy/clients.ts). Prisma calls
 * were always awaited, so nothing that uses `db` had to change.
 *
 * ## The one shape it refuses
 *
 * `$transaction([...])` — the array form — needs its queries built on one client before the call,
 * and here the client is only known once the call is under way. The type below offers only the
 * interactive form, `$transaction(async (tx) => …)`, so the array form fails to compile (and
 * ESLint and check:tenancy say so too).
 *
 * For a helper that takes a real `PrismaClient`, `await getTenantDb()`.
 */

type InteractiveTransaction = <R>(
  fn: (tx: Prisma.TransactionClient) => Promise<R>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel },
) => Promise<R>;

export type TenantDb = Omit<PrismaClient, "$transaction" | "$connect" | "$disconnect" | "$on" | "$use" | "$extends"> & {
  $transaction: InteractiveTransaction;
  /** Ends every workspace's pool — what a script does when it is finished. */
  $disconnect: () => Promise<void>;
};

/** The client as the current workspace's: every call on it runs as that workspace. */
export async function getTenantDb(): Promise<PrismaClient> {
  return clientFor(await currentTenant());
}

type Callable = (...args: unknown[]) => unknown;

/**
 * Lists that never include the platform's support staff.
 *
 * A support user (User.kind SUPPORT — src/lib/platform/support.ts) is a real account while a grant
 * lasts, but must not appear among the people: not in a picker, a report, a count or a seat. Rather
 * than sixty call sites each remembering, every listing of users made through `db` leaves them out,
 * and every listing of roles leaves out the role they sign in with. A query that names its rows —
 * by id, by key, or by kind itself — is left as it is: resolving "who did this" still finds them.
 *
 * The same goes for the workspace's own Automation account (User.kind AUTOMATION —
 * src/lib/automation-user.ts), which automatic postings are made by: only MEMBER accounts are listed.
 * A query this can't reach (one naming `id` or `kind`, or one inside a transaction) says `PEOPLE_ONLY`
 * (src/lib/people.ts) itself.
 *
 * Queries inside a transaction (`tx.user…`) are not touched; none of those list people.
 */
const LISTINGS = new Set(["findMany", "findFirst", "findFirstOrThrow", "count", "aggregate", "groupBy"]);

function withoutSupport(model: string, method: string, args: unknown[]): unknown[] {
  if (!LISTINGS.has(method) || (model !== "user" && model !== "role")) return args;
  const [first, ...rest] = args;
  const options = (first ?? {}) as { where?: Record<string, unknown> };
  const where = options.where ?? {};
  const pinned = model === "user" ? "id" in where || "kind" in where : "key" in where;
  if (pinned) return args;
  const exclude = model === "user" ? { kind: "MEMBER" } : { key: { not: SUPPORT_READONLY_ROLE } };
  return [{ ...options, where: { AND: [where, exclude] } }, ...rest];
}

function forward(path: [string] | [string, string]) {
  return async (...args: unknown[]) =>
    // As the workspace, its pool counted busy while it runs (src/lib/tenancy/clients.ts).
    withClient(await currentTenant(), async (prisma) => {
      const client = prisma as unknown as Record<string, Record<string, Callable> & Callable>;
      if (path.length === 1) return await (client[path[0]] as Callable).apply(client, args);
      const delegate = client[path[0]];
      return await (delegate[path[1]] as Callable).apply(delegate, withoutSupport(path[0], path[1], args));
    });
}

export const db = new Proxy({} as TenantDb, {
  get(_target, prop) {
    // Not a promise: `await db` or a `.then` probe must not look like one.
    if (typeof prop !== "string" || prop === "then") return undefined;
    if (prop === "$disconnect") return closeAllClients;
    // $queryRaw, $executeRaw, $transaction… — called straight on the client.
    if (prop.startsWith("$")) return forward([prop]);
    // A model: db.user.findMany(…) → the workspace client's user.findMany(…).
    return new Proxy(
      {},
      {
        get(_d, method) {
          if (typeof method !== "string" || method === "then") return undefined;
          return forward([prop, method]);
        },
      },
    );
  },
});
