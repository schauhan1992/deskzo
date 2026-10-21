import type { Prisma } from "@prisma/client";
import { fromPaise } from "@/lib/accounts/money";
import type { SystemAccountKey } from "@/lib/ledger/chart";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";

type Tx = Prisma.TransactionClient;

/**
 * Inventory's own journal entries, under perpetual inventory (owner, 22 Oct 2026). Periodic inventory — the
 * default, and how the books always worked — writes none: purchases are expensed as billed, and stock is
 * counted in quantities.
 *
 * Under perpetual inventory the Stock in Hand account follows the stock ledger:
 *
 *   · a bill that receives stock:   Dr Stock in Hand        Cr Purchases            (the bill posted Purchases)
 *   · a goods receipt before its bill: Dr Stock in Hand     Cr Goods Received Not Invoiced
 *   · the bill for that receipt:    Dr Goods Received NI    Cr Purchases
 *   · a sale:                       Dr Cost of Goods Sold   Cr Stock in Hand
 *   · goods returned by a customer: Dr Stock in Hand        Cr Cost of Goods Sold
 *   · stock found / written off:    Dr Stock in Hand / Dr Stock Adjustments, and the other side
 *   · goods returned to a vendor:   Dr Purchases            Cr Stock in Hand
 *
 * Each entry is written once, under its posting key, through the ledger's single door (`writeEntry`), and
 * undone only by its reversal.
 */

export type InventoryLine = { account: SystemAccountKey; debitPaise: number; creditPaise: number; companyId?: string | null };

export async function postInventoryEntry(
  tx: Tx,
  params: {
    postingKey: string;
    date: Date;
    narration: string;
    userId: string;
    lines: InventoryLine[];
    documentId?: string | null;
    stockDocumentId?: string | null;
    companyId?: string | null;
    branchId?: string | null;
  },
): Promise<{ id: string; entryNumber: string } | null> {
  const lines = params.lines.filter((l) => l.debitPaise > 0 || l.creditPaise > 0);
  if (lines.length < 2) return null;
  const accounts = await resolveAccounts(tx, [...new Set(lines.map((l) => l.account))]);
  return writeEntry(tx, {
    date: params.date,
    narration: params.narration,
    source: "INVENTORY",
    userId: params.userId,
    lines: lines.map((l) => ({
      accountId: accounts.get(l.account)!,
      debit: fromPaise(l.debitPaise),
      credit: fromPaise(l.creditPaise),
      companyId: l.companyId ?? null,
    })),
    documentId: params.documentId ?? null,
    stockDocumentId: params.stockDocumentId ?? null,
    companyId: params.companyId ?? null,
    branchId: params.branchId ?? null,
    postingKey: params.postingKey,
  });
}

/** One side to another, for an amount: the shape of almost every inventory entry. */
export function pair(debit: SystemAccountKey, credit: SystemAccountKey, paise: number): InventoryLine[] {
  if (paise <= 0) return [];
  return [
    { account: debit, debitPaise: paise, creditPaise: 0 },
    { account: credit, debitPaise: 0, creditPaise: paise },
  ];
}

/**
 * Reverses the entry written under `postingKey`, once (its reversal is keyed `<key>:reversal`). Nothing to do
 * when there was no entry, or it is already reversed.
 */
export async function reverseInventoryEntry(tx: Tx, postingKey: string, params: { userId: string; narration: string; date?: Date }) {
  const original = await tx.journalEntry.findUnique({
    where: { postingKey },
    select: {
      id: true, entryNumber: true, companyId: true, documentId: true, stockDocumentId: true, reversedBy: { select: { id: true } },
      lines: { orderBy: { sortOrder: "asc" }, select: { accountId: true, debit: true, credit: true, companyId: true, departmentId: true, branchId: true, gstRegistrationId: true, narration: true } },
    },
  });
  if (!original || original.reversedBy) return null;
  return writeEntry(tx, {
    date: params.date ?? new Date(),
    narration: `${params.narration} — reverses ${original.entryNumber}`,
    source: "INVENTORY",
    userId: params.userId,
    lines: original.lines.map((l) => ({
      accountId: l.accountId,
      debit: Number(l.credit),
      credit: Number(l.debit),
      companyId: l.companyId,
      departmentId: l.departmentId,
      branchId: l.branchId,
      gstRegistrationId: l.gstRegistrationId,
      narration: l.narration,
    })),
    documentId: original.documentId,
    stockDocumentId: original.stockDocumentId,
    companyId: original.companyId,
    reversesId: original.id,
    postingKey: `${postingKey}:reversal`,
  });
}
