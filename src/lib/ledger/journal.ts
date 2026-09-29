/**
 * The ledger's write path.
 *
 * Deliberately NOT a "use server" module: every function here takes the caller's Prisma transaction
 * so a posting commits with whatever caused it, and a transaction client can't cross a server-action
 * boundary. Exporting these as actions would also publish them as endpoints with no auth check.
 * The user-facing actions live in `src/actions/ledger.ts` and call into this.
 */
import type { JournalSource, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  DEFAULT_CHART,
  EXPENSE_CATEGORY_ACCOUNT,
  SYSTEM_ACCOUNTS,
  type SystemAccountKey,
} from "@/lib/ledger/chart";
import { formatExpenseId } from "@/lib/expenses";
import {
  entryTotals,
  hasOneSidedLines,
  isBalanced,
  postAssetDisposal,
  postChequeClearing,
  postCreditNote,
  postDepreciation,
  postExchangeDifference,
  postExpenseClaim,
  postExpenseReimbursement,
  postPaymentMade,
  postPaymentReceived,
  postPayrollPayment,
  postPayrollRun,
  postSalesInvoice,
  postVendorBill,
  postYearEndClose,
  bookingRate,
  exchangeDifference,
  inRupees,
  reverseLines,
  type PayrollTotals,
  type DocumentFinancials,
  type DraftLine,
} from "@/lib/ledger/posting";
import { financialYearOf } from "@/lib/gst-engine";
import { isLockedDate } from "@/lib/ledger/period";

type Tx = Prisma.TransactionClient;

/**
 * Creates the default chart the first time the ledger is opened.
 *
 * Idempotent, and safe to call on every read: a business that has already edited its chart keeps
 * what it has, and only genuinely missing system accounts are added back — which is what happens
 * when a later release introduces one, as TDS Payable did.
 *
 * `client` is the global client, or a posting's own transaction (see `resolveAccounts`).
 */
export async function ensureChartOfAccounts(client: Pick<Tx, "ledgerAccount"> = db): Promise<void> {
  const existing = await client.ledgerAccount.findMany({ select: { id: true, code: true, systemKey: true } });
  const haveCodes = new Set(existing.map((a) => a.code));
  const haveKeys = new Set(existing.filter((a) => a.systemKey).map((a) => a.systemKey));

  // An account that already exists under the right code but predates its system key adopts it,
  // rather than a second account appearing beside it under a different code. Books that have been
  // posting to "Travel & Conveyance" for a year should keep doing so once claims start posting —
  // otherwise the history splits across two accounts with the same name.
  for (const seed of DEFAULT_CHART) {
    if (!seed.systemKey || haveKeys.has(seed.systemKey)) continue;
    const match = existing.find((a) => a.code === seed.code && !a.systemKey);
    if (!match) continue;
    await client.ledgerAccount.update({ where: { id: match.id }, data: { systemKey: seed.systemKey } });
    haveKeys.add(seed.systemKey);
  }

  const missing = DEFAULT_CHART.filter(
    (a) => !haveCodes.has(a.code) && !(a.systemKey && haveKeys.has(a.systemKey)),
  );
  if (missing.length === 0) return;

  // Parents first, so a child always finds its parent's id.
  const byCode = new Map<string, string>(
    (await client.ledgerAccount.findMany({ select: { id: true, code: true } })).map((a) => [a.code, a.id]),
  );
  // Upsert rather than create, because `missing` was worked out before any of these ran and this
  // function is called by several report queries that a single page fires in parallel. They all
  // compute the same missing set, and the second one to reach a code hit the unique constraint on
  // it — a P2002 that took the whole Accounting page down rather than settling for the row that
  // was already there. Whoever arrives second now simply reads it.
  for (const seed of missing.sort((a, b) => a.code.localeCompare(b.code))) {
    const created = await client.ledgerAccount.upsert({
      where: { code: seed.code },
      update: {},
      create: {
        code: seed.code,
        name: seed.name,
        type: seed.type,
        isGroup: seed.isGroup ?? false,
        systemKey: seed.systemKey ?? null,
        description: seed.description ?? null,
        parentId: seed.parent ? (byCode.get(seed.parent) ?? null) : null,
      },
      select: { id: true, code: true },
    });
    byCode.set(created.code, created.id);
  }
}

/**
 * Refuses anything dated into closed books.
 *
 * Checked here rather than in each action, because `writeEntry` is the single door every entry goes
 * through — a lock that each caller has to remember is a lock that one of them will forget. It
 * applies to reversals and corrections too: the way to fix something in a closed period is to post
 * the correction in an open one, which is what an accountant would do on paper.
 */
export async function assertPeriodOpen(tx: Tx, date: Date) {
  const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  if (!lock?.lockedUntil) return;
  // By calendar day in India (period.ts): the lock is a date, and an entry at 12:00 UTC on the
  // locked day — every payroll and depreciation entry — is on that day, not after it.
  if (isLockedDate(date, lock.lockedUntil)) {
    const until = lock.lockedUntil.toISOString().slice(0, 10);
    throw new Error(
      `The books are closed to ${until}. Post this in an open period instead — reopening a closed one changes a trial balance somebody has already been given.`,
    );
  }
}

/**
 * Resolves system keys to account ids, failing loudly if the chart is incomplete.
 *
 * A workspace whose ledger nobody has opened yet has no chart at all, and only the accounting
 * screens used to create it — so a new workspace's first invoice (or payment) failed with "Chart of
 * accounts is missing". Now the first posting that finds accounts missing creates the default chart in
 * its own transaction and looks again; only a chart somebody has since broken still fails.
 */
export async function resolveAccounts(tx: Tx, keys: SystemAccountKey[]) {
  const lookup = async () => {
    const rows = await tx.ledgerAccount.findMany({
      where: { systemKey: { in: keys } },
      select: { id: true, systemKey: true },
    });
    return new Map(rows.map((r) => [r.systemKey as SystemAccountKey, r.id]));
  };
  let map = await lookup();
  if (keys.some((k) => !map.has(k))) {
    await ensureChartOfAccounts(tx);
    map = await lookup();
  }
  const missing = keys.filter((k) => !map.has(k));
  if (missing.length > 0) {
    throw new Error(`Chart of accounts is missing: ${missing.join(", ")}. Open Accounting → Chart of accounts to restore it.`);
  }
  return map;
}

/**
 * The next journal entry number for the financial year the entry falls in.
 *
 * Read from a counter row rather than from the entries themselves. Deriving it as
 * `max(entryNumber) + 1` looked reasonable and was wrong twice over: the maximum was taken
 * *lexicographically*, so "JV/2026-27/9999" outranked "JV/2026-27/10000" and the number stopped
 * advancing at ten thousand — after which every posting in that year failed on the unique index,
 * for good. And two concurrent transactions both read the same maximum, so an accountant issuing an
 * invoice while a colleague recorded a receipt could collide today, rolling one of them back with a
 * raw Prisma error.
 *
 * The upsert runs inside the caller's transaction, so the row lock it takes serialises the two.
 */
async function nextEntryNumber(tx: Tx, date: Date) {
  const fy = financialYearOf(date);
  const prefix = `JV/${fy}/`;

  // Only on the first entry of a year, and only on a database that already has entries from before
  // this counter existed: start past whatever is already in use rather than reissuing numbers.
  let seed = 1;
  const counter = await tx.journalCounter.findUnique({ where: { financialYear: fy }, select: { lastNumber: true } });
  if (!counter) {
    const existing = await tx.journalEntry.findMany({
      where: { entryNumber: { startsWith: prefix } },
      select: { entryNumber: true },
    });
    const highest = existing.reduce((max, row) => {
      const n = Number(row.entryNumber.slice(prefix.length));
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    seed = highest + 1;
  }

  const row = await tx.journalCounter.upsert({
    where: { financialYear: fy },
    create: { financialYear: fy, lastNumber: seed },
    update: { lastNumber: { increment: 1 } },
    select: { lastNumber: true },
  });

  // Padded to four, and simply wider beyond that. The width is cosmetic now that ordering does not
  // depend on it.
  return `${prefix}${String(row.lastNumber).padStart(4, "0")}`;
}

/**
 * Writes one balanced entry. The balance check lives here rather than in a database constraint
 * because Postgres can't express "these rows must sum to each other" — so every path that creates an
 * entry goes through this one function.
 *
 * Branch and GST registration are tags on the lines, not separate books (spec §8): `branchId` and
 * `gstRegistrationId` given here apply to every line that has no value of its own. Documents, payments
 * and expense claims are tagged, and so is a reversal, which copies its original's lines. Payroll,
 * payroll payments, depreciation, disposals, cheque clearings, exchange differences and the year-end
 * close are deliberately left untagged — null means "not attributed to a branch", which the P&L shows
 * as its own column rather than guessing one.
 */
export async function writeEntry(
  tx: Tx,
  params: {
    date: Date;
    narration: string;
    source: JournalSource;
    userId: string;
    lines: {
      accountId: string;
      debit: number;
      credit: number;
      companyId?: string | null;
      departmentId?: string | null;
      narration?: string | null;
      branchId?: string | null;
      gstRegistrationId?: string | null;
    }[];
    documentId?: string | null;
    payrollRunId?: string | null;
    paymentId?: string | null;
    expenseId?: string | null;
    companyId?: string | null;
    reversesId?: string | null;
    branchId?: string | null;
    gstRegistrationId?: string | null;
  },
) {
  await assertPeriodOpen(tx, params.date);
  if (params.lines.length < 2) throw new Error("A journal entry needs at least two lines.");
  if (!hasOneSidedLines(params.lines)) throw new Error("A line carries either a debit or a credit, not both.");
  if (!isBalanced(params.lines)) {
    const { debit, credit } = entryTotals(params.lines);
    throw new Error(`Entry does not balance: debits ${debit.toFixed(2)} vs credits ${credit.toFixed(2)}.`);
  }

  return tx.journalEntry.create({
    data: {
      entryNumber: await nextEntryNumber(tx, params.date),
      date: params.date,
      narration: params.narration,
      source: params.source,
      documentId: params.documentId ?? null,
      paymentId: params.paymentId ?? null,
      expenseId: params.expenseId ?? null,
      payrollRunId: params.payrollRunId ?? null,
      companyId: params.companyId ?? null,
      reversesId: params.reversesId ?? null,
      createdById: params.userId,
      lines: {
        create: params.lines.map((l, i) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          companyId: l.companyId ?? null,
          departmentId: l.departmentId ?? null,
          narration: l.narration ?? null,
          branchId: l.branchId ?? params.branchId ?? null,
          gstRegistrationId: l.gstRegistrationId ?? params.gstRegistrationId ?? null,
          sortOrder: i,
        })),
      },
    },
    select: { id: true, entryNumber: true },
  });
}

/**
 * A posting-engine line, plus the two tags. The engine (`posting.ts`) doesn't set them today — the
 * entry-level defaults in `writeEntry` do — but a line that carries its own is passed straight through.
 */
type TaggedDraftLine = DraftLine & { branchId?: string | null; gstRegistrationId?: string | null };

/** Turns the posting engine's keyed lines into rows with real account ids. */
async function materialise(tx: Tx, draft: { narration: string; lines: TaggedDraftLine[] }) {
  const keys = [...new Set(draft.lines.filter((l) => !l.accountIdOverride).map((l) => l.account))];
  const accounts = await resolveAccounts(tx, keys);
  return draft.lines.map((l: TaggedDraftLine) => ({
    // A line that named a real account wins: an asset's own account, or one P&L account being
    // closed, is chosen from data and has no system key to look up.
    accountId: l.accountIdOverride ?? accounts.get(l.account)!,
    debit: l.debit,
    credit: l.credit,
    companyId: l.companyId ?? null,
    departmentId: l.departmentId ?? null,
    narration: l.narration ?? null,
    branchId: l.branchId ?? null,
    gstRegistrationId: l.gstRegistrationId ?? null,
  }));
}

/**
 * The head office, read through the caller's transaction.
 *
 * Not `ensureHeadOffice()` or `branchIdentity()`: those go through `db` — another connection — and may
 * write (`adoptUnassigned` updates `trade_documents`), so inside a posting they could wait on the very
 * row this transaction holds, while it waits on them. With no head office the tag stays null.
 */
async function headOfficeOf(tx: Tx): Promise<{ id: string; gstRegistrationId: string | null } | null> {
  return tx.branch.findFirst({ where: { isHeadOffice: true }, select: { id: true, gstRegistrationId: true } });
}

/** What a document's posting reads from it: the figures, and the rate that brings them into rupees. */
export const documentPostingSelect = {
  id: true, docType: true, docNumber: true, companyId: true, issueDate: true,
  taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true,
  shippingCharge: true, withholdingAmount: true, adjustment: true, adjustmentLabel: true,
  roundOff: true, total: true, currency: true, exchangeRate: true, branchId: true, gstRegistrationId: true,
} satisfies Prisma.TradeDocumentSelect;

export type PostableDocument = Prisma.TradeDocumentGetPayload<{ select: typeof documentPostingSelect }>;

/**
 * The books are kept in rupees. A document written in another currency posts converted at the rate
 * agreed on the day it was raised (`inRupees`); the difference when it settles is booked separately,
 * on the payment. Until the rate was added to `documentPostingSelect` it never reached here, so every
 * foreign document posted at 1 — a $1,000 invoice booked ₹1,000 (`npm run ledger:repost-fx`).
 */
function financialsOf(doc: PostableDocument): DocumentFinancials {
  const n = (v: Prisma.Decimal | number) => Number(v);
  return inRupees(
    {
      companyId: doc.companyId,
      docNumber: doc.docNumber,
      taxableValue: n(doc.taxableValue),
      cgstAmount: n(doc.cgstAmount),
      sgstAmount: n(doc.sgstAmount),
      igstAmount: n(doc.igstAmount),
      shippingCharge: n(doc.shippingCharge),
      withholdingAmount: n(doc.withholdingAmount),
      adjustment: n(doc.adjustment),
      adjustmentLabel: doc.adjustmentLabel,
      roundOff: n(doc.roundOff),
      total: n(doc.total),
    },
    bookingRate(doc),
  );
}

/** The sources a document's own posting is written under — not a reversal's, not an exchange difference's. */
export const DOCUMENT_SOURCES = ["INVOICE", "CREDIT_NOTE", "BILL"] as const satisfies readonly JournalSource[];

/**
 * The entry that books a document now: its own posting, not a reversal, and not reversed since.
 *
 * A document normally has one posting. After `ledger:repost-fx` has repaired it, it has two — the
 * original, reversed, and the re-post — and only the re-post is live, so that is the one a
 * cancellation must reverse. An `FX` entry carries the document too, which is why the source is
 * part of the question.
 */
function currentDocumentEntryWhere(documentId: string) {
  return {
    documentId,
    source: { in: [...DOCUMENT_SOURCES] },
    reversesId: null,
    reversedBy: { is: null },
  } satisfies Prisma.JournalEntryWhereInput;
}

export async function currentDocumentEntry(tx: Tx, documentId: string) {
  return tx.journalEntry.findFirst({
    where: currentDocumentEntryWhere(documentId),
    orderBy: { createdAt: "desc" },
    select: { id: true, entryNumber: true },
  });
}

/**
 * Writes a document's entry: at its issue date when it is first posted, or on the day the repair
 * chooses when `ledger:repost-fx` posts it again. The repair passes the original's branch and GSTIN
 * so the re-post lands where the original did.
 */
export async function writeDocumentEntry(
  tx: Tx,
  doc: PostableDocument,
  userId: string,
  at: { date: Date; note?: string; tags?: { branchId: string | null; gstRegistrationId: string | null } },
): Promise<{ id: string; entryNumber: string }> {
  if (doc.docType !== "INVOICE" && doc.docType !== "CREDIT_NOTE" && doc.docType !== "BILL") {
    throw new Error(`A ${doc.docType} does not post to the ledger.`);
  }
  const financials = financialsOf(doc);
  const draft =
    doc.docType === "INVOICE"
      ? postSalesInvoice(financials)
      : doc.docType === "CREDIT_NOTE"
        ? postCreditNote(financials)
        : postVendorBill(financials);

  // Every line, receivable and revenue included, carries the document's branch and GSTIN: the tax
  // lines are what a return per registration sums, the rest are what a P&L per branch sums. A document
  // an older build wrote without a branch is the head office's, as readers take it (spec §13.2).
  const tags = at.tags ?? {
    branchId: doc.branchId ?? (await headOfficeOf(tx))?.id ?? null,
    gstRegistrationId: doc.gstRegistrationId,
  };

  return writeEntry(tx, {
    date: at.date,
    narration: at.note ? `${draft.narration} — ${at.note}` : draft.narration,
    source: doc.docType,
    userId,
    lines: await materialise(tx, draft),
    documentId: doc.id,
    companyId: doc.companyId,
    branchId: tags.branchId,
    gstRegistrationId: tags.gstRegistrationId,
  });
}

/**
 * Posts a document to the ledger. Called when an invoice, credit note or bill is issued.
 *
 * Runs inside the caller's transaction so a document can never be issued without its entry, or an
 * entry written for a document that then failed to issue. Posting the same document twice is a
 * no-op rather than an error — issuing is idempotent in places and double-posting would silently
 * double the revenue.
 */
export async function postDocumentToLedger(
  tx: Tx,
  documentId: string,
  userId: string,
): Promise<{ id: string; entryNumber: string } | null> {
  const doc = await tx.tradeDocument.findUnique({ where: { id: documentId }, select: documentPostingSelect });
  if (!doc) return null;
  // Quotes, proformas and purchase orders are commitments, not transactions — nothing has happened
  // in accounting terms until an invoice or a bill exists.
  if (doc.docType !== "INVOICE" && doc.docType !== "CREDIT_NOTE" && doc.docType !== "BILL") return null;

  // Posted already if it has any posting of its own, reversed or not: the live one is returned when
  // there is one (a repaired document's re-post), and a cancelled document's reversed original
  // otherwise — cancelling is final, and posting again would put its revenue back.
  const posted = await tx.journalEntry.findMany({
    where: { documentId, source: { in: [...DOCUMENT_SOURCES] }, reversesId: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, entryNumber: true, reversedBy: { select: { id: true } } },
  });
  if (posted.length > 0) {
    const entry = posted.find((e) => !e.reversedBy) ?? posted[0];
    return { id: entry.id, entryNumber: entry.entryNumber };
  }

  return writeDocumentEntry(tx, doc, userId, { date: doc.issueDate });
}

/** Posts a payment. Direction decides whether it settles a receivable or a payable. */
export async function postPaymentToLedger(
  tx: Tx,
  paymentId: string,
  userId: string,
): Promise<{ id: string; entryNumber: string } | null> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true, companyId: true, amount: true, paidOn: true, method: true, reference: true, direction: true,
      bankAccountId: true, clearedOn: true, currency: true, exchangeRate: true, branchId: true,
      company: { select: { name: true } },
    },
  });
  if (!payment) return null;

  const already = await tx.journalEntry.findFirst({
    where: { paymentId, reversesId: null },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const intoCash = payment.method === "CASH";
  // In rupees, which is what the ledger holds — a foreign receipt is converted at its own rate.
  const amount = Math.round(Number(payment.amount) * (Number(payment.exchangeRate) || 1) * 100) / 100;
  const draft =
    payment.direction === "PAID"
      ? postPaymentMade({
          companyId: payment.companyId,
          amount,
          reference: payment.reference,
          fromCash: intoCash,
          partyName: payment.company.name,
        })
      : postPaymentReceived({
          companyId: payment.companyId,
          amount,
          reference: payment.reference,
          intoCash,
          partyName: payment.company.name,
        });

  // Which pot the money landed in: a named bank account, cash, or — for a cheque nobody has banked
  // yet — cheques in hand. The posting functions name it BANK or CASH generically; this is where
  // that becomes a real account.
  const money = await resolveMoneyAccount(tx, payment);
  const moneyIndex = payment.direction === "PAID" ? 1 : 0;
  const lines = (await materialise(tx, draft)).map((l, i) =>
    i === moneyIndex ? { ...l, accountId: money.accountId } : l,
  );

  return writeEntry(tx, {
    date: payment.paidOn,
    narration: draft.narration,
    source: "PAYMENT",
    userId,
    lines,
    paymentId: payment.id,
    companyId: payment.companyId,
    // The branch that took or made the payment. No GSTIN: money moving carries no tax.
    branchId: payment.branchId ?? (await headOfficeOf(tx))?.id ?? null,
  });
}

/**
 * What a reversal reads from each original line: everything but the direction, which it swaps.
 *
 * The cost centre and the branch and GSTIN tags go with the amount — a reversal that dropped them
 * would leave the original's branch, GSTIN or team carrying a figure the company as a whole had
 * cancelled. The cost centre was dropped until the branch tags were added (X8).
 */
export const reversibleLineSelect = {
  accountId: true, debit: true, credit: true, companyId: true, departmentId: true, narration: true,
  branchId: true, gstRegistrationId: true,
} satisfies Prisma.JournalLineSelect;

/** The original's lines, debit and credit swapped, every tag kept — ready for `writeEntry`. */
export function reversedLines(lines: Prisma.JournalLineGetPayload<{ select: typeof reversibleLineSelect }>[]) {
  return reverseLines(lines.map((l) => ({ ...l, debit: Number(l.debit), credit: Number(l.credit) })));
}

/**
 * Reverses whatever a document posted, used when it's cancelled.
 *
 * Runs inside the caller's transaction and is quiet about a document that was never posted — a
 * cancelled draft has no entry to reverse, and that isn't an error.
 *
 * It reverses the document's *current* entry. It used to take the first entry carrying the document,
 * which after a repair is the original the repair already reversed — so it found nothing to do and
 * left the re-post standing — and could be an exchange difference, which is the payment's.
 */
export async function reverseDocumentPosting(tx: Tx, documentId: string, userId: string) {
  const original = await tx.journalEntry.findFirst({
    where: currentDocumentEntryWhere(documentId),
    orderBy: { createdAt: "desc" },
    select: {
      id: true, entryNumber: true, companyId: true,
      lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect },
    },
  });
  if (!original) return null;

  return writeEntry(tx, {
    date: new Date(),
    narration: `Reversal of ${original.entryNumber} — document cancelled`,
    source: "MANUAL",
    userId,
    lines: reversedLines(original.lines),
    companyId: original.companyId,
    reversesId: original.id,
  });
}

/**
 * Unposts a payment, the way `reverseDocumentPosting` unposts a document.
 *
 * Deleting a payment used to leave its journal entry standing with a dangling `paymentId`, so the
 * bank was overstated and receivables understated by the amount — permanently, and invisibly, since
 * a trial balance still balanced. The entry is reversed rather than deleted for the same reason a
 * cancelled invoice is: a posted period is a statement somebody may already have filed, and the way
 * to undo a statement is another statement.
 */
export async function reversePaymentPosting(tx: Tx, paymentId: string, userId: string) {
  const original = await tx.journalEntry.findFirst({
    where: { paymentId, reversesId: null },
    select: {
      id: true, entryNumber: true, companyId: true,
      reversedBy: { select: { id: true } },
      lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect },
    },
  });
  if (!original || original.reversedBy) return null;

  return writeEntry(tx, {
    date: new Date(),
    narration: `Reversal of ${original.entryNumber} — payment deleted`,
    source: "MANUAL",
    userId,
    lines: reversedLines(original.lines),
    companyId: original.companyId,
    reversesId: original.id,
  });
}


// ─── Where money actually sits ────────────────────────────────────────────────

/**
 * The account a payment moves through.
 *
 * Three things decide it, in order:
 *
 *   · An uncleared cheque is not in the bank. It sits in cheques-in-hand (received) or
 *     cheques-issued (paid) until it clears, which is what lets a bank balance reconcile at all.
 *   · Cash is cash.
 *   · Otherwise it is a specific bank account if one was chosen, the default bank account if not,
 *     and the plain BANK account if nobody has set any up — which is what every payment recorded
 *     before bank accounts existed did.
 */
export async function resolveMoneyAccount(
  tx: Tx,
  payment: { method: string; bankAccountId: string | null; clearedOn: Date | null; direction: string },
): Promise<{ accountId: string; kind: "CASH" | "BANK" | "CHEQUE" }> {
  const keys = await resolveAccounts(tx, [
    SYSTEM_ACCOUNTS.CASH,
    SYSTEM_ACCOUNTS.BANK,
    SYSTEM_ACCOUNTS.CHEQUES_IN_HAND,
    SYSTEM_ACCOUNTS.CHEQUES_ISSUED,
  ]);

  if (payment.method === "CHEQUE" && !payment.clearedOn) {
    return {
      accountId:
        payment.direction === "PAID"
          ? keys.get(SYSTEM_ACCOUNTS.CHEQUES_ISSUED)!
          : keys.get(SYSTEM_ACCOUNTS.CHEQUES_IN_HAND)!,
      kind: "CHEQUE",
    };
  }
  if (payment.method === "CASH") return { accountId: keys.get(SYSTEM_ACCOUNTS.CASH)!, kind: "CASH" };

  if (payment.bankAccountId) {
    const chosen = await tx.bankAccount.findUnique({
      where: { id: payment.bankAccountId },
      select: { ledgerAccountId: true },
    });
    if (chosen) return { accountId: chosen.ledgerAccountId, kind: "BANK" };
  }
  const fallback = await tx.bankAccount.findFirst({
    where: { isDefault: true, active: true },
    select: { ledgerAccountId: true },
  });
  return { accountId: fallback?.ledgerAccountId ?? keys.get(SYSTEM_ACCOUNTS.BANK)!, kind: "BANK" };
}

/** The ledger account behind a bank, for the reconciliation and cash-flow views. */
export async function bankLedgerAccountId(bankAccountId: string): Promise<string | null> {
  const row = await db.bankAccount.findUnique({
    where: { id: bankAccountId },
    select: { ledgerAccountId: true },
  });
  return row?.ledgerAccountId ?? null;
}

// ─── Expenses ─────────────────────────────────────────────────────────────────

/**
 * Where a claim books: the claimant's branch while it is active, else the head office; and that
 * branch's GSTIN, else the head office's, else none — on every line (spec §8.2).
 *
 * Taking the input tax under the claimant's GSTIN is a default, not the law: ITC belongs to the GSTIN
 * named on the supplier's invoice, which a claim does not record (CA question C7).
 */
async function expenseTags(
  tx: Tx,
  branch: { id: string; active: boolean; gstRegistrationId: string | null } | null,
): Promise<{ branchId: string | null; gstRegistrationId: string | null }> {
  const own = branch?.active ? branch : null;
  const headOffice = own?.gstRegistrationId ? null : await headOfficeOf(tx);
  return {
    branchId: own?.id ?? headOffice?.id ?? null,
    gstRegistrationId: own?.gstRegistrationId ?? headOffice?.gstRegistrationId ?? null,
  };
}

/**
 * Posts an approved claim.
 *
 * Idempotent on the expense, like every other posting here: approving twice, or an approval that
 * retries, must not book the cost twice. A claim the company paid directly still posts — the cost
 * is just as real, there is simply nobody to reimburse.
 */
export async function postExpenseToLedger(
  tx: Tx,
  expenseId: string,
  userId: string,
): Promise<{ id: string; entryNumber: string } | null> {
  const expense = await tx.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      expenseSeq: true,
      category: true,
      amount: true,
      taxAmount: true,
      spentOn: true,
      description: true,
      paymentMode: true,
      reimbursable: true,
      companyId: true,
      user: { select: { name: true, departmentId: true, branch: { select: { id: true, active: true, gstRegistrationId: true } } } },
    },
  });
  if (!expense) return null;

  const already = await tx.journalEntry.findFirst({
    where: { expenseId, reversesId: null, source: "EXPENSE" },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const draft = postExpenseClaim({
    amount: Number(expense.amount),
    taxAmount: Number(expense.taxAmount ?? 0),
    categoryAccount: EXPENSE_CATEGORY_ACCOUNT[expense.category],
    claimant: expense.user.name,
    description: expense.description,
    reference: formatExpenseId(expense.expenseSeq),
    // Company-card and direct-debit spend is money that has already left; nobody is owed it.
    companyPaid: !expense.reimbursable,
    fromCash: expense.paymentMode === "CASH",
    departmentId: expense.user.departmentId,
  });

  return writeEntry(tx, {
    date: expense.spentOn,
    narration: draft.narration,
    source: "EXPENSE",
    userId,
    lines: await materialise(tx, draft),
    expenseId: expense.id,
    companyId: expense.companyId,
    ...(await expenseTags(tx, expense.user.branch)),
  });
}

/** Posts the reimbursement itself — the day the employee is actually paid back. */
export async function postExpenseReimbursementToLedger(
  tx: Tx,
  expenseId: string,
  userId: string,
  paidOn: Date,
): Promise<{ id: string; entryNumber: string } | null> {
  const expense = await tx.expense.findUnique({
    where: { id: expenseId },
    select: {
      id: true,
      expenseSeq: true,
      amount: true,
      reimbursable: true,
      paymentMode: true,
      user: { select: { name: true, branch: { select: { id: true, active: true, gstRegistrationId: true } } } },
    },
  });
  // Nothing to settle on spend the company already paid for directly.
  if (!expense || !expense.reimbursable) return null;

  const already = await tx.journalEntry.findFirst({
    where: { expenseId, source: "PAYMENT", reversesId: null },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const draft = postExpenseReimbursement({
    amount: Number(expense.amount),
    claimant: expense.user.name,
    reference: formatExpenseId(expense.expenseSeq),
    fromCash: expense.paymentMode === "CASH",
  });

  return writeEntry(tx, {
    date: paidOn,
    narration: draft.narration,
    source: "PAYMENT",
    userId,
    lines: await materialise(tx, draft),
    expenseId: expense.id,
    // Tagged as the claim was, so the branch that owed the money is the branch that paid it.
    ...(await expenseTags(tx, expense.user.branch)),
  });
}

// ─── Payroll ──────────────────────────────────────────────────────────────────

/**
 * Posts a month's payroll, once the run is locked.
 *
 * Locked and not draft on purpose: a draft run is still being corrected, and a wage bill that moves
 * after it has been booked is how a P&L ends up disagreeing with the payslips behind it.
 */
export async function postPayrollToLedger(
  tx: Tx,
  runId: string,
  userId: string,
): Promise<{ id: string; entryNumber: string } | null> {
  const run = await tx.payrollRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      month: true,
      year: true,
      payslips: {
        select: {
          grossEarnings: true,
          pfEmployee: true,
          pfEmployer: true,
          esiEmployee: true,
          esiEmployer: true,
          professionalTax: true,
          incomeTax: true,
          otherDeduction: true,
          netPay: true,
          user: { select: { departmentId: true } },
        },
      },
    },
  });
  if (!run || run.payslips.length === 0) return null;

  const already = await tx.journalEntry.findFirst({
    where: { payrollRunId: runId, source: "PAYROLL", reversesId: null },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const n = (v: Prisma.Decimal | number) => Number(v);
  const totals: PayrollTotals = run.payslips.reduce(
    (t, p) => ({
      grossEarnings: t.grossEarnings + n(p.grossEarnings),
      pfEmployee: t.pfEmployee + n(p.pfEmployee),
      pfEmployer: t.pfEmployer + n(p.pfEmployer),
      esiEmployee: t.esiEmployee + n(p.esiEmployee),
      esiEmployer: t.esiEmployer + n(p.esiEmployer),
      professionalTax: t.professionalTax + n(p.professionalTax),
      incomeTax: t.incomeTax + n(p.incomeTax),
      otherDeduction: t.otherDeduction + n(p.otherDeduction),
      netPay: t.netPay + n(p.netPay),
    }),
    {
      grossEarnings: 0, pfEmployee: 0, pfEmployer: 0, esiEmployee: 0, esiEmployer: 0,
      professionalTax: 0, incomeTax: 0, otherDeduction: 0, netPay: 0,
    },
  );

  // Gross per team, so the wage line carries a cost centre.
  const byTeam = new Map<string | null, number>();
  for (const p of run.payslips) {
    const key = p.user.departmentId ?? null;
    byTeam.set(key, (byTeam.get(key) ?? 0) + n(p.grossEarnings));
  }

  const draft = postPayrollRun({
    totals,
    monthLabel: payrollMonthLabel(run.month, run.year),
    byDepartment: [...byTeam].map(([departmentId, grossEarnings]) => ({ departmentId, grossEarnings })),
  });

  return writeEntry(tx, {
    date: lastDayOfMonth(run.month, run.year),
    narration: draft.narration,
    source: "PAYROLL",
    userId,
    lines: await materialise(tx, draft),
    payrollRunId: run.id,
  });
}

/** Payday — the net pay actually leaving the bank. */
export async function postPayrollPaymentToLedger(
  tx: Tx,
  runId: string,
  userId: string,
  paidOn: Date,
): Promise<{ id: string; entryNumber: string } | null> {
  const run = await tx.payrollRun.findUnique({
    where: { id: runId },
    select: { id: true, month: true, year: true, payslips: { select: { netPay: true } } },
  });
  if (!run || run.payslips.length === 0) return null;

  const already = await tx.journalEntry.findFirst({
    where: { payrollRunId: runId, source: "PAYMENT", reversesId: null },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const netPay = run.payslips.reduce((t, p) => t + Number(p.netPay), 0);
  const draft = postPayrollPayment({
    netPay,
    monthLabel: payrollMonthLabel(run.month, run.year),
    fromCash: false,
  });

  return writeEntry(tx, {
    date: paidOn,
    narration: draft.narration,
    source: "PAYMENT",
    userId,
    lines: await materialise(tx, draft),
    payrollRunId: run.id,
  });
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function payrollMonthLabel(month: number, year: number) {
  return (MONTH_NAMES[month - 1] ?? String(month)) + " " + year;
}

/**
 * Payroll is dated to the last day of the month it is for, not to the day somebody pressed the
 * button — a September run locked in October belongs in September's P&L.
 */
function lastDayOfMonth(month: number, year: number) {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0));
}

// ─── Cheques ──────────────────────────────────────────────────────────────────

/** Moves a cheque out of cheques-in-hand (or cheques-issued) and into the bank it cleared through. */
export async function postChequeClearingToLedger(
  tx: Tx,
  paymentId: string,
  userId: string,
  clearedOn: Date,
): Promise<{ id: string; entryNumber: string } | null> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true, amount: true, reference: true, direction: true, method: true,
      bankAccountId: true, exchangeRate: true, currency: true,
      company: { select: { name: true } },
    },
  });
  if (!payment || payment.method !== "CHEQUE") return null;

  const already = await tx.journalEntry.findFirst({
    where: { paymentId, source: "PAYMENT", narration: { contains: "cleared" }, reversesId: null },
    select: { id: true, entryNumber: true },
  });
  if (already) return already;

  const received = payment.direction !== "PAID";
  const draft = postChequeClearing({
    amount: Number(payment.amount) * Number(payment.exchangeRate),
    received,
    partyName: payment.company.name,
    reference: payment.reference,
  });

  // The bank half goes to the real account the cheque cleared through.
  const bank = await resolveMoneyAccount(tx, {
    method: "BANK_TRANSFER",
    bankAccountId: payment.bankAccountId,
    clearedOn,
    direction: payment.direction,
  });
  const lines = (await materialise(tx, draft)).map((l, i) =>
    (received && i === 0) || (!received && i === 1) ? { ...l, accountId: bank.accountId } : l,
  );

  return writeEntry(tx, {
    date: clearedOn,
    narration: draft.narration,
    source: "PAYMENT",
    userId,
    lines,
    paymentId: payment.id,
  });
}

// ─── Depreciation ─────────────────────────────────────────────────────────────

/** Posts one asset's charge for a period, and records it so the same period can't be charged twice. */
export async function postDepreciationToLedger(
  tx: Tx,
  params: {
    assetId: string;
    amount: number;
    fromDate: Date;
    toDate: Date;
    periodLabel: string;
    userId: string;
  },
): Promise<{ id: string; entryNumber: string } | null> {
  if (params.amount <= 0) return null;

  const asset = await tx.fixedAsset.findUnique({
    where: { id: params.assetId },
    select: { id: true, name: true, tag: true, departmentId: true, accumulatedAccountId: true },
  });
  if (!asset) return null;

  const existing = await tx.depreciationCharge.findUnique({
    where: { assetId_toDate: { assetId: asset.id, toDate: params.toDate } },
    select: { entryId: true, entry: { select: { id: true, entryNumber: true } } },
  });
  if (existing?.entry) return existing.entry;

  const draft = postDepreciation({
    amount: params.amount,
    periodLabel: params.periodLabel,
    assetName: asset.tag + " " + asset.name,
    departmentId: asset.departmentId,
  });

  let lines = await materialise(tx, draft);
  // An asset with its own accumulated-depreciation account uses it; otherwise the shared one.
  if (asset.accumulatedAccountId) {
    lines = lines.map((l, i) => (i === 1 ? { ...l, accountId: asset.accumulatedAccountId! } : l));
  }

  const entry = await writeEntry(tx, {
    date: params.toDate,
    narration: draft.narration,
    source: "DEPRECIATION",
    userId: params.userId,
    lines,
  });

  await tx.depreciationCharge.upsert({
    where: { assetId_toDate: { assetId: asset.id, toDate: params.toDate } },
    create: {
      assetId: asset.id,
      fromDate: params.fromDate,
      toDate: params.toDate,
      amount: params.amount,
      entryId: entry.id,
      createdById: params.userId,
    },
    update: { entryId: entry.id, amount: params.amount },
  });

  return entry;
}

/** Takes an asset off the books, with the gain or loss falling out of the figures. */
export async function postAssetDisposalToLedger(
  tx: Tx,
  params: { assetId: string; proceeds: number; disposedOn: Date; userId: string },
): Promise<{ id: string; entryNumber: string } | null> {
  const asset = await tx.fixedAsset.findUnique({
    where: { id: params.assetId },
    select: {
      id: true, name: true, tag: true, cost: true, assetAccountId: true, disposalEntryId: true,
      charges: { select: { amount: true } },
    },
  });
  if (!asset || asset.disposalEntryId) return null;

  const accumulated = asset.charges.reduce((t, c) => t + Number(c.amount), 0);
  const draft = postAssetDisposal({
    cost: Number(asset.cost),
    accumulated,
    proceeds: params.proceeds,
    assetAccountId: asset.assetAccountId,
    assetName: asset.tag + " " + asset.name,
    fromCash: false,
  });

  return writeEntry(tx, {
    date: params.disposedOn,
    narration: draft.narration,
    source: "MANUAL",
    userId: params.userId,
    lines: await materialise(tx, { narration: draft.narration, lines: draft.lines }),
  });
}

// ─── Foreign currency ─────────────────────────────────────────────────────────

/**
 * Books the exchange difference when a payment settles a document raised at a different rate.
 *
 * Called on allocation rather than on the payment, because the difference only exists once you know
 * which document the money is against — the same $1,000 could be settling an invoice raised at ₹83
 * or one raised at ₹86, and those are different gains.
 *
 * Domestic settlements pass through untouched: both rates are 1, the difference is zero, and
 * nothing is written.
 */
export async function postExchangeDifferenceToLedger(
  tx: Tx,
  params: {
    paymentId: string;
    documentId: string;
    /** In the foreign currency — the figure the allocation was made in. */
    allocatedAmount: number;
    userId: string;
  },
): Promise<{ id: string; entryNumber: string } | null> {
  const [payment, doc] = await Promise.all([
    tx.payment.findUnique({
      where: { id: params.paymentId },
      select: {
        id: true, companyId: true, currency: true, exchangeRate: true, paidOn: true, direction: true,
        company: { select: { name: true } },
      },
    }),
    tx.tradeDocument.findUnique({
      where: { id: params.documentId },
      select: { id: true, docNumber: true, docType: true, currency: true, exchangeRate: true },
    }),
  ]);
  if (!payment || !doc) return null;

  const paymentRate = Number(payment.exchangeRate) || 1;
  // The rate the document was booked at (posting.ts `bookingRate`), which is what the receivable or
  // payable holds and so what this payment is measured against.
  const docRate = bookingRate(doc);
  if (paymentRate === docRate) return null;
  // A rate difference between two different currencies is not an exchange gain, it is a mistake.
  if (payment.currency !== doc.currency) return null;

  const difference = exchangeDifference(params.allocatedAmount, paymentRate, docRate);
  const draft = postExchangeDifference({
    companyId: payment.companyId,
    difference,
    receivable: doc.docType !== "BILL",
    partyName: payment.company.name,
    docNumber: doc.docNumber,
  });
  if (!draft) return null;

  return writeEntry(tx, {
    date: payment.paidOn,
    narration: draft.narration,
    source: "FX",
    userId: params.userId,
    lines: await materialise(tx, draft),
    paymentId: payment.id,
    documentId: doc.id,
    companyId: payment.companyId,
  });
}

// ─── Year end ─────────────────────────────────────────────────────────────────

/**
 * Writes the closing entry for a financial year.
 *
 * The balances are read from the journal rather than passed in, so what is closed is exactly what
 * the trial balance says — a closing entry built from a figure somebody typed is a closing entry
 * that leaves a remainder.
 *
 * `from` and `to` are a half-open window of instants — 1 April 00:00 IST up to the next 1 April
 * (src/lib/india-time.ts `financialYearWindow`). The year end used to be midnight UTC on 31 March,
 * compared with `lte`: that is 05:30 IST on the year's last day, so March's payroll and depreciation
 * (12:00 UTC) and everything else posted later that day stayed out of the closing entry. `date` is
 * the day the entry itself is dated, inside the year.
 */
export async function postYearEndCloseToLedger(
  tx: Tx,
  params: { from: Date; to: Date; date: Date; label: string; userId: string },
): Promise<{ entry: { id: string; entryNumber: string } | null; netProfit: number }> {
  const accounts = await tx.ledgerAccount.findMany({
    where: { isGroup: false, type: { in: ["INCOME", "EXPENSE"] } },
    select: { id: true, type: true },
  });
  if (accounts.length === 0) return { entry: null, netProfit: 0 };

  const sums = await tx.journalLine.groupBy({
    by: ["accountId"],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      entry: { date: { gte: params.from, lt: params.to } },
    },
    _sum: { debit: true, credit: true },
  });

  const balances = accounts
    .map((a) => {
      const row = sums.find((s) => s.accountId === a.id);
      const debit = Number(row?._sum.debit ?? 0);
      const credit = Number(row?._sum.credit ?? 0);
      // Each in its own natural direction: income is credit-natured, expense debit-natured, so a
      // positive number means "this account did what it normally does".
      const balance = a.type === "INCOME" ? credit - debit : debit - credit;
      return { accountId: a.id, type: a.type as "INCOME" | "EXPENSE", balance: Math.round(balance * 100) / 100 };
    })
    .filter((a) => a.balance !== 0);

  const draft = postYearEndClose({ label: params.label, accounts: balances });
  if (draft.lines.length === 0) return { entry: null, netProfit: 0 };

  const entry = await writeEntry(tx, {
    date: params.date,
    narration: draft.narration,
    source: "CLOSING",
    userId: params.userId,
    lines: await materialise(tx, { narration: draft.narration, lines: draft.lines }),
  });
  return { entry, netProfit: draft.netProfit };
}
