/**
 * Postgres takes at most 32,767 values in one query, and Prisma sends each id of an `in: [...]` as one: a
 * list past that fails the query outright ("the query parameter limit supported by your database is
 * exceeded") — which a large workspace reaches (the load test, 23 Oct 2026: the leads board, 53,000 leads).
 * Where a list of ids can grow with the workspace, ask in batches.
 */
export const ID_BATCH = 10_000;

/** `read` once per batch of `ids`, the results one after another — a single call when they fit. */
export async function inBatches<T, R>(ids: readonly T[], read: (batch: T[]) => Promise<R[]>, size = ID_BATCH): Promise<R[]> {
  if (ids.length <= size) return read([...ids]);
  const out: R[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await read(ids.slice(i, i + size))));
  return out;
}
