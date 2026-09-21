import { db } from "@/lib/db";
import type { Exporter } from "./types";

/**
 * The chart of accounts — and only that.
 *
 * The ledger area exports accounts rather than journal entries. An entry is one balanced posting the
 * system made, and a file of entries is an invitation to hand them back; an imported entry balances
 * against nothing and the document it claims to record never existed. `entities.ts` marks
 * JournalEntry and JournalLine "archive" for exactly that reason, which is where the history belongs.
 * What is genuinely portable is the shape of the books: the accounts, their types and the tree.
 *
 * `systemKey` is not a column, here or in the importer. It is how the posting engine finds the
 * receivables account and the bank account without depending on a code or a name somebody may change.
 * A file carrying it is a file in which "AR" can be dragged onto the wrong row, after which every
 * future invoice posts to the wrong account and nothing anywhere complains. It cannot leave, so it
 * cannot come back.
 *
 * Rows are ordered parents first rather than by code. The importer resolves Parent by looking the
 * code up in what already exists, so in plain code order a child numbered before its parent fails on
 * the way into an empty system. Code order breaks the tie, so the file still reads as a chart.
 *
 * Not company-scoped: a chart of accounts belongs to the business rather than to anybody's accounts.
 */
export const ledgerExporter: Exporter = async () => {
  const rows = await db.ledgerAccount.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      parentId: true,
      isGroup: true,
      active: true,
      description: true,
    },
  });

  const byId = new Map(rows.map((a) => [a.id, a]));
  const depths = new Map<string, number>();
  const depthOf = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    let depth = 0;
    let current = byId.get(id);
    const seen = new Set<string>([id]);
    // A parent chain should never loop — the importer refuses to make one — but a chart that somehow
    // does must still export rather than hang.
    while (current?.parentId && !seen.has(current.parentId)) {
      seen.add(current.parentId);
      depth += 1;
      current = byId.get(current.parentId);
    }
    depths.set(id, depth);
    return depth;
  };

  return rows
    .sort((a, b) => depthOf(a.id) - depthOf(b.id) || a.code.localeCompare(b.code))
    .map((a) => ({
      Code: a.code,
      Name: a.name,
      Type: a.type,
      Parent: a.parentId ? (byId.get(a.parentId)?.code ?? "") : "",
      Group: a.isGroup,
      Active: a.active,
      Description: a.description ?? "",
    }));
};
