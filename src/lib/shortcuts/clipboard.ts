/**
 * BUSY's F12 / Alt + F12 — a voucher copied, and pasted into a new one (owner, 22 Oct 2026). Kept in this
 * browser (localStorage), one per kind, and also put on the system clipboard as text where the browser allows,
 * so it can be read elsewhere. Only what the form would have typed: no ids of the voucher itself, its number,
 * its status or who did what — a pasted voucher is a new draft.
 */

export type VoucherCopy = {
  kind: "voucher";
  type: string;
  narration: string;
  reference: string;
  companyId: string | null;
  lines: { accountId: string; debit: string; credit: string; companyId: string | null; departmentId: string | null; branchId: string | null; narration: string }[];
  /** The parties' names, so a pasted line shows whose it is without asking the server again. */
  parties?: { id: string; name: string }[];
  copiedFrom: string;
  copiedAt: string;
};

export type StockVoucherCopy = {
  kind: "stock";
  type: string;
  warehouseId: string;
  toWarehouseId: string | null;
  companyId: string | null;
  reference: string;
  reason: string;
  notes: string;
  lines: { itemId: string; itemName: string; quantity: string; unitCost: string; batchNo: string; note: string }[];
  copiedFrom: string;
  copiedAt: string;
};

type Copy = VoucherCopy | StockVoucherCopy;

const KEY = (kind: Copy["kind"]) => `deskzo.copied-${kind}`;

/** Copies; true where it was kept (private windows and blocked storage keep nothing). */
export function copyVoucher(copy: Copy): boolean {
  let kept = false;
  try {
    localStorage.setItem(KEY(copy.kind), JSON.stringify(copy));
    kept = true;
  } catch {
    kept = false;
  }
  try {
    void navigator.clipboard?.writeText(JSON.stringify(copy, null, 2)).catch(() => {});
  } catch {
    // The system clipboard is a bonus; the browser's own copy is what pasting reads.
  }
  return kept;
}

/** The voucher last copied of this kind, if any. */
export function copiedVoucher<K extends Copy["kind"]>(kind: K): Extract<Copy, { kind: K }> | null {
  try {
    const raw = localStorage.getItem(KEY(kind));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Copy;
    return parsed?.kind === kind && Array.isArray(parsed.lines) ? (parsed as Extract<Copy, { kind: K }>) : null;
  } catch {
    return null;
  }
}
