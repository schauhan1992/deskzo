import type { JournalSource, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { bookingRate, takenFromPayment } from "@/lib/ledger/posting";
import { DOCUMENT_SOURCES } from "@/lib/ledger/journal";
import { indiaClock } from "@/lib/time/zone";
import { dayKey, monthEnd, monthLabel, monthWindow } from "@/lib/close/months";
import { detailOf, inr, round2, type CheckDetail, type CheckOutcome, type DetailItem } from "@/lib/close/checks";

/**
 * Receivables and payables tied to the ledger (checklist tasks 9 and 10).
 *
 * The ageing is rebuilt here as it stood at the month end — the ageing screens (src/actions/receivable.ts,
 * payable.ts) answer for today, in each document's own currency, and floor every balance at zero, none
 * of which a tie-out can use. So:
 *
 *   · **As of the month end.** A document counts once issued by then, and while its posting stood in
 *     the ledger then: one cancelled on 2 October was still owed on 30 September. A payment counts once
 *     dated by then, with what it had been set against.
 *   · **In rupees, at each document's own rate** — the rate its posting used (`bookingRate`), so a $1,000
 *     invoice raised at ₹83 is ₹83,000 however it later settles. What a payment settles is measured at
 *     the document's rate too: the payment clears amount × its own rate, and the exchange-difference entry
 *     adds back the difference, which nets to amount × the document's rate (P0, F1). What a payment has
 *     *not* been set against is money on account, at the payment's own rate.
 *   · **Nothing floored.** An overpaid invoice is a negative balance, an unapplied receipt and an
 *     unapplied credit note are negatives, and they all count — the ledger nets them, so the ageing must.
 *
 * That total must equal the Accounts Receivable (or Payable) balance at the month end, within ₹1. When
 * it doesn't, the detail lists what usually explains it: manual journals on the account in the month (and
 * how many before), lines on it with no party, receipts not set against anything, documents whose own
 * entry disagrees with their total, and payment entries whose payment was since deleted.
 */

export type TieOutSide = "AR" | "AP";

/** A document the ageing is made of, with what the loader found for it at the month end. */
export type TieOutDocument = {
  id: string;
  docNumber: string;
  /** VENDOR_CREDIT: a distributor's or an OEM's credit note (src/actions/vendor-credit.ts), on the payables side — it reads as a credit note does. */
  docType: "INVOICE" | "CREDIT_NOTE" | "BILL" | "VENDOR_CREDIT";
  companyId: string;
  companyName: string;
  currency: string;
  /** The rate its posting used (`bookingRate`). */
  rate: number;
  /** In its own currency. */
  total: number;
  /** Payments dated by the month end set against it, in its currency. */
  allocated: number;
  /** Credit notes applied to it by the month end, in its currency — on a bill, vendor credit notes. */
  credited: number;
  /** A credit note's: how much of it was applied to invoices (a vendor credit note's, to bills) by the month end. */
  applied: number;
  /** Its own entries' effect on the account as the ledger stood at the month end: + adds to what is owed. */
  posted: number;
  /** Whether any posting of its own stood in the ledger then. */
  hasEntry: boolean;
  entryNumbers: string[];
};

export type TieOutPayment = {
  id: string;
  label: string;
  companyId: string;
  companyName: string;
  currency: string;
  rate: number;
  amount: number;
  /** Set against documents in the ageing, in the payment's currency. */
  applied: number;
};

export type TieOutEntry = { id: string; entryNumber: string; date: Date; narration: string; amount: number };

export type TieOutInput = {
  side: TieOutSide;
  month: Date;
  documents: TieOutDocument[];
  payments: TieOutPayment[];
  /** The account's balance at the month end, owed-positive (AR: debit − credit; AP: credit − debit). */
  ledger: number;
  manualInMonth: TieOutEntry[];
  manualBefore: { count: number; amount: number };
  partyless: { count: number; amount: number; items: TieOutEntry[] };
  orphanPayments: { count: number; amount: number; items: TieOutEntry[] };
};

type Cause = { count: number; amount: number; items: DetailItem[] };

export type TieOutDetail = CheckDetail & {
  side: TieOutSide;
  /** The ageing total, the ledger balance, and ageing − ledger; all rupees, owed-positive. */
  ageing: number;
  ledger: number;
  difference: number;
  tolerance: number;
  breakdown: { documents: number; creditNotes: number; unappliedPayments: number };
  causes: {
    mismatchedDocuments: Cause;
    manualJournals: Cause;
    manualJournalsBefore: { count: number; amount: number };
    partylessLines: Cause;
    unappliedPayments: Cause;
    orphanPaymentEntries: Cause;
  };
};

/** ₹1: rounding each document and receipt to the paisa can leave a few paise between the two sides. */
export const TIE_OUT_TOLERANCE = 1;

const r2 = (n: number, rate: number) => round2(n * rate);

/** A document's balance at the month end, in rupees at its rate: what it adds to (or, a credit note, takes off) the ageing. */
const isCreditNote = (doc: TieOutDocument) => doc.docType === "CREDIT_NOTE" || doc.docType === "VENDOR_CREDIT";

export function openInRupees(doc: TieOutDocument): number {
  if (isCreditNote(doc)) return -round2(r2(doc.total, doc.rate) - r2(doc.applied, doc.rate));
  return round2(r2(doc.total, doc.rate) - r2(doc.allocated, doc.rate) - r2(doc.credited, doc.rate));
}

/** What a document's own posting should have put on the account: + for an invoice or bill, − for a credit note. */
export function expectedPosting(doc: TieOutDocument): number {
  const amount = r2(doc.total, doc.rate);
  return isCreditNote(doc) ? -amount : amount;
}

// The entry's day in the books: India's, in every workspace.
const entryItem = (e: TieOutEntry): DetailItem => ({
  id: e.id,
  label: `${e.entryNumber} · ${indiaClock.dateKey(e.date)}`,
  href: `/accounting/journal?q=${encodeURIComponent(e.entryNumber)}`,
  amount: e.amount,
  note: e.narration,
});

/** The tie-out itself: pure, over what `loadTieOut` read. */
export function tieOut(input: TieOutInput): CheckOutcome<TieOutDetail> {
  const key = input.side === "AR" ? "ar-ties" : "ap-ties";
  const book = input.side === "AR" ? "receivables" : "payables";

  let documents = 0;
  let creditNotes = 0;
  const mismatched: DetailItem[] = [];
  let mismatchAmount = 0;
  for (const doc of input.documents) {
    const open = openInRupees(doc);
    if (isCreditNote(doc)) creditNotes = round2(creditNotes + open);
    else documents = round2(documents + open);
    const expected = expectedPosting(doc);
    const gap = round2(doc.posted - expected);
    if (!doc.hasEntry || Math.abs(gap) >= 0.01) {
      mismatchAmount = round2(mismatchAmount + gap);
      mismatched.push({
        id: doc.id,
        label: `${doc.docNumber} · ${doc.companyName}`,
        href: doc.docType === "VENDOR_CREDIT" ? `/purchase/vendor-credits/${doc.id}` : `/documents/${doc.id}`,
        amount: gap,
        note: doc.hasEntry
          ? `Posted ${inr(doc.posted)} (${doc.entryNumbers.join(", ")}) against ${inr(expected)}${doc.rate !== 1 ? ` at ${doc.currency} ${doc.rate}` : ""}`
          : `No entry in the ledger for its ${inr(expected)}`,
      });
    }
  }

  const unapplied: DetailItem[] = [];
  let unappliedPayments = 0;
  for (const p of input.payments) {
    const left = round2(p.amount - p.applied);
    if (Math.abs(left) < 0.005) continue;
    const rupees = r2(left, p.rate);
    unappliedPayments = round2(unappliedPayments - rupees);
    unapplied.push({
      id: p.id,
      label: `${p.label} · ${p.companyName}`,
      href: `/companies/${p.companyId}`,
      amount: rupees,
      note: p.currency === "INR" ? "Not set against any document" : `${p.currency} ${left.toFixed(2)} not set against any document`,
    });
  }

  const ageing = round2(documents + creditNotes + unappliedPayments);
  const ledger = round2(input.ledger);
  const difference = round2(ageing - ledger);
  const ok = Math.abs(difference) <= TIE_OUT_TOLERANCE;

  const manual = input.manualInMonth.map(entryItem);
  const partyless = input.partyless.items.map(entryItem);
  const orphans = input.orphanPayments.items.map(entryItem);
  const sum = (items: TieOutEntry[]) => round2(items.reduce((t, e) => t + e.amount, 0));
  const causes: TieOutDetail["causes"] = {
    mismatchedDocuments: { count: mismatched.length, amount: mismatchAmount, items: mismatched.slice(0, 50) },
    manualJournals: { count: manual.length, amount: sum(input.manualInMonth), items: manual.slice(0, 50) },
    manualJournalsBefore: input.manualBefore,
    partylessLines: { count: input.partyless.count, amount: input.partyless.amount, items: partyless.slice(0, 50) },
    unappliedPayments: { count: unapplied.length, amount: unappliedPayments, items: unapplied.slice(0, 50) },
    orphanPaymentEntries: { count: input.orphanPayments.count, amount: input.orphanPayments.amount, items: orphans.slice(0, 50) },
  };

  const asOf = dayKey(monthEnd(input.month));
  const summary = ok
    ? `The ${book} ageing (${inr(ageing)}) agrees with the ledger at ${asOf}${difference !== 0 ? `, ${inr(Math.abs(difference))} apart` : ""}.`
    : `The ${book} ageing (${inr(ageing)}) is ${inr(Math.abs(difference))} ${difference > 0 ? "more" : "less"} than the ledger (${inr(ledger)}) at ${asOf}.`;

  // The records a person follows up, most telling first. A tie-out that agrees lists none — the causes
  // are still there to read.
  const items = ok ? [] : [...mismatched, ...manual, ...partyless, ...orphans, ...unapplied];
  const base = detailOf(key, input.month, summary, items, {
    ageing,
    ledger,
    difference,
    documents: input.documents.length,
    mismatchedDocuments: mismatched.length,
    manualJournals: manual.length,
    partylessLines: input.partyless.count,
    unappliedPayments: unapplied.length,
  });
  return {
    ok,
    detail: {
      ...base,
      side: input.side,
      ageing,
      ledger,
      difference,
      tolerance: TIE_OUT_TOLERANCE,
      breakdown: { documents, creditNotes, unappliedPayments },
      causes,
    },
  };
}

// ─── The loader ──────────────────────────────────────────────────────────────────────────────

/** Entries a person wrote: manual journals and opening balances, and reversals of those — not a cancellation's or a deletion's. */
const PERSON_SOURCES: JournalSource[] = ["MANUAL", "OPENING"];

type LineRow = { debit: Prisma.Decimal; credit: Prisma.Decimal };

/** Reads, as the ledger and the documents stood at the month end, what `tieOut` needs. */
export async function loadTieOut(side: TieOutSide, month: Date): Promise<TieOutInput> {
  const { from, to } = monthWindow(month);
  const account = await db.ledgerAccount.findUnique({
    where: { systemKey: side === "AR" ? SYSTEM_ACCOUNTS.AR : SYSTEM_ACCOUNTS.AP },
    select: { id: true },
  });
  // Owed-positive: a receivable is a debit balance, a payable a credit one.
  const owed = (l: LineRow) => (side === "AR" ? Number(l.debit) - Number(l.credit) : Number(l.credit) - Number(l.debit));

  const docs = await db.tradeDocument.findMany({
    where: {
      docType: { in: side === "AR" ? ["INVOICE", "CREDIT_NOTE"] : ["BILL"] },
      status: { not: "DRAFT" },
      issueDate: { lt: to },
    },
    select: {
      id: true, docNumber: true, docType: true, status: true, companyId: true, currency: true, exchangeRate: true, total: true,
      company: { select: { name: true } },
      payments: { where: { payment: { paidOn: { lt: to } } }, select: { amount: true } },
      creditsReceived: { where: { createdAt: { lt: to }, creditNote: { issueDate: { lt: to }, status: { not: "DRAFT" } } }, select: { amount: true } },
      creditsApplied: { where: { createdAt: { lt: to }, invoice: { issueDate: { lt: to } } }, select: { amount: true } },
      // A bill's: vendor credit notes set against it by the month end.
      vendorCredits: { where: { createdAt: { lt: to } }, select: { amount: true } },
    },
  });

  // Every document's own postings dated by the month end, and whether each had been reversed by then.
  const postings = new Map<string, { posted: number; entryNumbers: string[] }>();
  if (account) {
    const lines = await db.journalLine.findMany({
      where: {
        accountId: account.id,
        entry: { source: { in: [...DOCUMENT_SOURCES] }, documentId: { not: null }, reversesId: null, date: { lt: to } },
      },
      select: {
        debit: true, credit: true,
        entry: { select: { id: true, entryNumber: true, documentId: true, reversedBy: { select: { date: true } } } },
      },
    });
    const counted = new Set<string>();
    for (const l of lines) {
      const reversedBy = l.entry.reversedBy;
      if (reversedBy && reversedBy.date.getTime() < to.getTime()) continue;
      const row = postings.get(l.entry.documentId!) ?? { posted: 0, entryNumbers: [] };
      row.posted = round2(row.posted + owed(l));
      if (!counted.has(l.entry.id)) {
        counted.add(l.entry.id);
        row.entryNumbers.push(l.entry.entryNumber);
      }
      postings.set(l.entry.documentId!, row);
    }
  }

  const sumOf = (rows: { amount: Prisma.Decimal }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);
  const documents: TieOutDocument[] = [];
  for (const d of docs) {
    const posting = postings.get(d.id);
    // A cancelled document was still owed at the month end if its posting was standing then.
    if (d.status === "CANCELLED" && !posting) continue;
    documents.push({
      id: d.id,
      docNumber: d.docNumber,
      docType: d.docType as TieOutDocument["docType"],
      companyId: d.companyId,
      companyName: d.company.name,
      currency: d.currency,
      rate: bookingRate(d),
      total: Number(d.total),
      allocated: round2(sumOf(d.payments)),
      credited: round2(sumOf(d.creditsReceived) + sumOf(d.vendorCredits)),
      applied: round2(sumOf(d.creditsApplied)),
      posted: posting?.posted ?? 0,
      hasEntry: !!posting,
      entryNumbers: posting?.entryNumbers ?? [],
    });
  }
  /**
   * Payables: a distributor's or an OEM's credit note takes what we owe down (Dr AP) and is set against
   * their bills. A payout into the bank never touches the account, so only credit notes count; one
   * cancelled by the month end drops out with its posting, as a cancelled document does.
   */
  if (side === "AP") {
    const credits = await db.vendorCredit.findMany({
      where: { form: "CREDIT_NOTE", date: { lt: to } },
      select: {
        id: true, reference: true, vendorId: true, total: true, cancelledAt: true,
        vendor: { select: { name: true } },
        applications: { where: { createdAt: { lt: to } }, select: { amount: true } },
      },
    });
    const creditPostings = new Map<string, { posted: number; entryNumbers: string[] }>();
    if (account && credits.length > 0) {
      const lines = await db.journalLine.findMany({
        where: { accountId: account.id, entry: { source: "VENDOR_CREDIT", vendorCreditId: { not: null }, reversesId: null, date: { lt: to } } },
        select: { debit: true, credit: true, entry: { select: { id: true, entryNumber: true, vendorCreditId: true, reversedBy: { select: { date: true } } } } },
      });
      const counted = new Set<string>();
      for (const l of lines) {
        const reversedBy = l.entry.reversedBy;
        if (reversedBy && reversedBy.date.getTime() < to.getTime()) continue;
        const row = creditPostings.get(l.entry.vendorCreditId!) ?? { posted: 0, entryNumbers: [] };
        row.posted = round2(row.posted + owed(l));
        if (!counted.has(l.entry.id)) {
          counted.add(l.entry.id);
          row.entryNumbers.push(l.entry.entryNumber);
        }
        creditPostings.set(l.entry.vendorCreditId!, row);
      }
    }
    for (const c of credits) {
      const posting = creditPostings.get(c.id);
      if (c.cancelledAt && c.cancelledAt.getTime() < to.getTime() && !posting) continue;
      documents.push({
        id: c.id,
        docNumber: c.reference,
        docType: "VENDOR_CREDIT",
        companyId: c.vendorId,
        companyName: c.vendor.name,
        currency: "INR",
        rate: 1,
        total: Number(c.total),
        allocated: 0,
        credited: 0,
        applied: round2(sumOf(c.applications)),
        posted: posting?.posted ?? 0,
        hasEntry: !!posting,
        entryNumbers: posting?.entryNumbers ?? [],
      });
    }
  }
  const live = new Set(documents.map((d) => d.id));

  const paymentRows = await db.payment.findMany({
    where: { direction: side === "AR" ? "RECEIVED" : "PAID", paidOn: { lt: to } },
    select: {
      id: true, paymentSeq: true, companyId: true, currency: true, exchangeRate: true, amount: true,
      company: { select: { name: true } },
      allocations: { where: { documentId: { not: null } }, select: { documentId: true, amount: true, paymentAmount: true } },
    },
  });
  const payments: TieOutPayment[] = paymentRows.map((p) => ({
    id: p.id,
    label: `Payment #${p.paymentSeq}`,
    companyId: p.companyId,
    companyName: p.company.name,
    currency: p.currency,
    // As its posting converts it (postPaymentToLedger).
    rate: Number(p.exchangeRate) || 1,
    amount: Number(p.amount),
    // What each allocation took out of the payment, in its currency: rupees on account set against a USD
    // invoice settle dollars but spend rupees (`takenFromPayment`).
    applied: round2(p.allocations.filter((a) => a.documentId && live.has(a.documentId)).reduce((t, a) => t + takenFromPayment(a), 0)),
  }));

  if (!account) {
    return {
      side, month, documents, payments, ledger: 0,
      manualInMonth: [], manualBefore: { count: 0, amount: 0 },
      partyless: { count: 0, amount: 0, items: [] }, orphanPayments: { count: 0, amount: 0, items: [] },
    };
  }

  const balance = await db.journalLine.aggregate({
    where: { accountId: account.id, entry: { date: { lt: to } } },
    _sum: { debit: true, credit: true },
  });
  const ledger = round2(
    side === "AR"
      ? Number(balance._sum.debit ?? 0) - Number(balance._sum.credit ?? 0)
      : Number(balance._sum.credit ?? 0) - Number(balance._sum.debit ?? 0),
  );

  const byEntry = (
    lines: { debit: Prisma.Decimal; credit: Prisma.Decimal; entry: { id: string; entryNumber: string; date: Date; narration: string } }[],
  ): TieOutEntry[] => {
    const map = new Map<string, TieOutEntry>();
    for (const l of lines) {
      const row = map.get(l.entry.id) ?? { id: l.entry.id, entryNumber: l.entry.entryNumber, date: l.entry.date, narration: l.entry.narration, amount: 0 };
      row.amount = round2(row.amount + owed(l));
      map.set(l.entry.id, row);
    }
    return [...map.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
  };
  const entrySelect = { id: true, entryNumber: true, date: true, narration: true } as const;
  const manualEntry = {
    source: { in: PERSON_SOURCES },
    OR: [{ reversesId: null }, { reverses: { source: { in: PERSON_SOURCES } } }],
  } satisfies Prisma.JournalEntryWhereInput;

  const [manualLines, manualBeforeLines, partylessLines, orphanLines] = await Promise.all([
    db.journalLine.findMany({
      where: { accountId: account.id, entry: { ...manualEntry, date: { gte: from, lt: to } } },
      select: { debit: true, credit: true, entry: { select: entrySelect } },
    }),
    db.journalLine.findMany({
      where: { accountId: account.id, entry: { ...manualEntry, date: { lt: from } } },
      select: { debit: true, credit: true, entry: { select: entrySelect } },
    }),
    db.journalLine.findMany({
      where: { accountId: account.id, companyId: null, entry: { date: { lt: to } } },
      select: { debit: true, credit: true, entry: { select: entrySelect } },
    }),
    // A payment's entries once the payment is gone: the foreign key let go of it (SetNull), and unless
    // the entry was reversed by the month end it still moves the account with no receipt behind it.
    db.journalLine.findMany({
      where: {
        accountId: account.id,
        entry: {
          source: { in: ["PAYMENT", "FX"] },
          paymentId: null, expenseId: null, payrollRunId: null, reversesId: null,
          date: { lt: to },
          OR: [{ reversedBy: { is: null } }, { reversedBy: { date: { gte: to } } }],
        },
      },
      select: { debit: true, credit: true, entry: { select: entrySelect } },
    }),
  ]);

  const manualBefore = byEntry(manualBeforeLines);
  const partyless = byEntry(partylessLines);
  const orphans = byEntry(orphanLines);
  const total = (rows: TieOutEntry[]) => round2(rows.reduce((t, e) => t + e.amount, 0));

  return {
    side,
    month,
    documents,
    payments,
    ledger,
    manualInMonth: byEntry(manualLines),
    manualBefore: { count: manualBefore.length, amount: total(manualBefore) },
    partyless: { count: partyless.length, amount: total(partyless), items: partyless.slice(-50) },
    orphanPayments: { count: orphans.length, amount: total(orphans), items: orphans.slice(-50) },
  };
}

/** The tie-out for a side at a month end — loaded and judged. */
export async function tieOutAt(side: TieOutSide, month: Date): Promise<CheckOutcome<TieOutDetail>> {
  return tieOut(await loadTieOut(side, month));
}

/** For a heading: "Receivables at 30 Sep 2026". */
export function tieOutTitle(side: TieOutSide, month: Date): string {
  return `${side === "AR" ? "Receivables" : "Payables"} at the end of ${monthLabel(month)}`;
}
