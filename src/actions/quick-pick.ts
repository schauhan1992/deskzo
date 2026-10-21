"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";

/**
 * What BUSY's report keys pick before they open (owner, 22 Oct 2026): Alt + L an account for its ledger, Alt + I
 * and Ctrl + D an item for its summary or stock ledger (src/lib/shortcuts/busy.ts). Each asks what the page it
 * leads to asks — an account's ledger is the books' reader's, an item is whoever may open Items — so a picker
 * never lists what its page would then refuse.
 */

const LIMIT = 20;

/** Postable accounts matching a code or a name — for the account ledger. */
export async function pickAccounts(term: string) {
  const user = await requireModuleUser("accounting");
  if (!(await can(user.id, "ledger.viewReports"))) return [];
  const q = term.trim();
  return db.ledgerAccount.findMany({
    where: {
      isGroup: false,
      ...(q ? { OR: [{ code: { startsWith: q } }, { name: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ active: "desc" }, { code: "asc" }],
    take: LIMIT,
    select: { id: true, code: true, name: true, active: true },
  });
}

/** Items matching a name, SKU or barcode — goods that keep stock first. */
export async function pickItems(term: string, options: { stockOnly?: boolean } = {}) {
  await requireModuleUser("items");
  const q = term.trim();
  const rows = await db.item.findMany({
    where: {
      ...(options.stockOnly ? { type: "GOOD", trackInventory: true } : {}),
      ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ active: "desc" }, { name: "asc" }],
    take: LIMIT,
    select: { id: true, name: true, sku: true, type: true, trackInventory: true, active: true },
  });
  return rows;
}
