import type { Prisma, PrismaClient } from "@prisma/client";
import { clientFor, closeAllClients } from "@/lib/tenancy/clients";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * The database — the current workspace's.
 *
 * Every workspace has a database of its own. `db` looks and types like the one Prisma client the
 * app always had, and every call on it first finds the workspace the work is for (see
 * src/lib/tenancy/resolve.ts), then runs on that workspace's client. Prisma calls were always
 * awaited, so nothing that uses `db` had to change.
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
  /** Closes every workspace's client — what a script does when it is finished. */
  $disconnect: () => Promise<void>;
};

/** The current workspace's own client. */
export async function getTenantDb(): Promise<PrismaClient> {
  return clientFor(await currentTenant());
}

type Callable = (...args: unknown[]) => unknown;

function forward(path: [string] | [string, string]) {
  return async (...args: unknown[]) => {
    const client = (await getTenantDb()) as unknown as Record<string, Record<string, Callable> & Callable>;
    if (path.length === 1) return (client[path[0]] as Callable).apply(client, args);
    const delegate = client[path[0]];
    return (delegate[path[1]] as Callable).apply(delegate, args);
  };
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
