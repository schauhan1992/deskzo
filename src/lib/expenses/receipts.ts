import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * When an expense claim needs its receipt (owner, 22 Oct 2026): over an amount an admin sets in Settings › Expense
 * approvals, a claim can't be submitted without a photo of it — from the web and the Deskzo app alike. A draft can
 * wait for one; submitting is when it's asked for. Unset, a receipt is never required.
 */

/** The amount above which a claim needs a receipt, in rupees — null when none is set, or the workspace hasn't the setting yet. */
export async function receiptRequiredAbove(): Promise<number | null> {
  try {
    const row = await db.expenseSettings.findUnique({ where: { id: "global" }, select: { receiptRequiredAbove: true } });
    return row?.receiptRequiredAbove === null || row?.receiptRequiredAbove === undefined ? null : Number(row.receiptRequiredAbove);
  } catch (err) {
    // 20261122160000_field_work not here yet: as before it, never required.
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Why a claim of `amount` can't go in without a receipt, or null when it can. Pure. */
export function receiptRefusal(amount: number, hasReceipt: boolean, above: number | null): string | null {
  if (above === null || hasReceipt || !(amount > above)) return null;
  return `A claim over ₹${above.toLocaleString("en-IN")} needs a photo of its receipt. Add one, then submit it.`;
}
