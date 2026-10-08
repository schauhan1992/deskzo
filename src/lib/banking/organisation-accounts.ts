import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { BranchIdentity } from "@/lib/branches/format";

/**
 * Which of the organisation's bank accounts a sales document prints (owner, 8 Oct 2026: "primary,
 * changeable per document"). First match wins:
 *
 *   1. the account the document names — kept even once retired, so a reprint is the paper it was;
 *   2. its branch's default (a null branch is the head office), while that account is in use;
 *   3. the organisation's primary, while in use;
 *   4. nothing.
 *
 * Read live, as the rest of the letterhead is. Never throws: a workspace still waiting for migration
 * 20261028110000 has no accounts table, so it prints the single bank block it had before.
 */

export type PrintedBankAccount = {
  label: string;
  accountHolderName: string | null;
  bankName: string | null;
  branchName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  upiId: string | null;
};

export const PRINTED_FIELDS = {
  label: true,
  accountHolderName: true,
  bankName: true,
  branchName: true,
  accountNumber: true,
  ifsc: true,
  swift: true,
  upiId: true,
} satisfies Prisma.OrganisationBankAccountSelect;

/** The single bank block of before, as an account — what a workspace not yet migrated prints. */
function legacyAccount(identity: Pick<BranchIdentity, "bankName" | "bankBranch" | "bankAccountNumber" | "bankIfsc" | "upiId">): PrintedBankAccount | null {
  if (!identity.bankName && !identity.bankAccountNumber && !identity.upiId) return null;
  return {
    label: "Bank details",
    accountHolderName: null,
    bankName: identity.bankName,
    branchName: identity.bankBranch,
    accountNumber: identity.bankAccountNumber,
    ifsc: identity.bankIfsc,
    swift: null,
    upiId: identity.upiId,
  };
}

/** What prints on this document. `identity` is its branch's (src/lib/branches/identity.ts). */
export async function printedBankAccount(documentId: string, identity: BranchIdentity): Promise<PrintedBankAccount | null> {
  try {
    const [document, branch] = await Promise.all([
      db.tradeDocument.findUnique({ where: { id: documentId }, select: { bankAccount: { select: PRINTED_FIELDS } } }),
      db.branch.findUnique({ where: { id: identity.branchId }, select: { defaultBankAccount: { select: { ...PRINTED_FIELDS, active: true } } } }),
    ]);
    if (document?.bankAccount) return document.bankAccount;
    if (branch?.defaultBankAccount) {
      const { active, ...account } = branch.defaultBankAccount;
      if (active) return account;
    }
    return await db.organisationBankAccount.findFirst({ where: { isPrimary: true, active: true }, select: PRINTED_FIELDS });
  } catch (err) {
    // One line, not the stack: in the minutes before a workspace's migration this is every print.
    const reason = err instanceof Error ? err.message.trim().split("\n").at(-1) : String(err);
    console.error(`[banking] organisation accounts unavailable (${reason}); printing the old bank block`);
    return legacyAccount(identity);
  }
}

/** An account as the document form and the branch form offer it. */
export type BankAccountChoice = { id: string; label: string; isPrimary: boolean; active: boolean };

/** An account as a picker shows it: its name, and the last four of its number or its UPI id. */
export function accountChoiceLabel(a: { label: string; accountNumber: string | null; upiId: string | null; bankName: string | null }): string {
  const tail = a.accountNumber ? `•••• ${a.accountNumber.slice(-4)}` : a.upiId;
  return [a.label, [a.bankName, tail].filter(Boolean).join(" ")].filter(Boolean).join(" — ");
}

/**
 * For a picker: the accounts in use, plus any ids passed (a document's or branch's account since
 * retired — the form must still show what the record says). Empty in a workspace not yet migrated,
 * when the forms say nothing about accounts.
 */
export async function bankAccountChoices(include: (string | null | undefined)[] = []): Promise<BankAccountChoice[]> {
  const ids = include.filter((id): id is string => Boolean(id));
  try {
    const rows = await db.organisationBankAccount.findMany({
      where: ids.length ? { OR: [{ active: true }, { id: { in: ids } }] } : { active: true },
      select: { id: true, label: true, accountNumber: true, upiId: true, bankName: true, isPrimary: true, active: true },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return rows.map((r) => ({ id: r.id, label: accountChoiceLabel(r), isPrimary: r.isPrimary, active: r.active }));
  } catch {
    return [];
  }
}

/** What the document form needs to offer an account, and to say which one "default" would print. */
export type DocumentBankChoices = {
  accounts: BankAccountChoice[];
  /** Each branch's default, when it is an account in use; else null (the primary prints). */
  branchDefaults: Record<string, string | null>;
  /** The document's own pick, "" for none — on a new document always "". */
  current: string;
};

export async function documentBankChoices(documentId?: string): Promise<DocumentBankChoices> {
  // By name: both columns are in NOT_YET_EVERYWHERE until every workspace has 20261028110000.
  const [document, branches] = await Promise.all([
    documentId ? db.tradeDocument.findUnique({ where: { id: documentId }, select: { bankAccountId: true } }).catch(() => null) : null,
    db.branch.findMany({ select: { id: true, defaultBankAccountId: true } }).catch(() => []),
  ]);
  const current = document?.bankAccountId ?? "";
  const accounts = await bankAccountChoices([current]);
  const inUse = new Set(accounts.filter((a) => a.active).map((a) => a.id));
  return {
    accounts,
    branchDefaults: Object.fromEntries(branches.map((b) => [b.id, b.defaultBankAccountId && inUse.has(b.defaultBankAccountId) ? b.defaultBankAccountId : null])),
    current,
  };
}
