import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { round2 } from "@/lib/close/checks";
import { PERSON_ENTRY, type TieOutDocument, type TieOutPayment, type TieOutSide } from "@/lib/close/tieout";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { bookingRate, settlementDifference, takenFromPayment } from "@/lib/ledger/posting";
import { isBaseCurrency } from "@/lib/currency";
import { calendarDayRange } from "@/lib/time/zone";
import { calendarDateOf } from "@/lib/india-time";
import { agingBucket, daysOverdue, emptyAging, withRunningBalance, type AgingBucket, type LedgerEntry } from "@/lib/receivables";
import { summariseBalances, type JournalAmount } from "@/lib/receivables/balance-summary";

/**
 * A party's statement of account (owner, 21 Oct 2026): every invoice (or bill), payment, credit note,
 * exchange difference and journal on their account in date order, in rupees, with one running balance —
 * and under it what is open in each other currency they deal in.
 *
 * Until then a statement added a $1,000 invoice and a ₹50,000 payment as 1,000 − 50,000. Now every line is
 * in rupees at its own rate — a document at the rate it was raised at, a payment at the rate it came in at —
 * and a foreign line shows what it was written for beside it. When a foreign document settles at another
 * rate the ledger books the difference (`postExchangeDifferenceToLedger`), and the statement shows it as a
 * line, so the closing balance is what Accounts Receivable (or Payable) holds for the party and what their
 * row in the Customer or Vendor Balance Summary says (src/lib/receivables/balance-summary.ts): the figures
 * come from the same `summariseBalances`.
 *
 * A credit note applied to an invoice raised at another rate books nothing in the ledger, so there the two
 * can be apart by that difference — the one case the statement doesn't reconcile.
 *
 * The whole party, as the balance summary counts it: the caller decides whether this person may see it.
 */

export type StatementSide = TieOutSide;

/** What is open in one foreign currency, as the documents and payments are written. */
export type CurrencyBalance = { currency: string; open: number; unused: number; balance: number };

export type OpenDocument = {
  id: string;
  docNumber: string;
  issueDate: Date;
  dueDate: Date | null;
  /** In its own currency. */
  balance: number;
  currency: string;
  /** In rupees at its own rate. */
  rupees: number;
  daysOverdue: number;
  bucket: AgingBucket;
};

export type PartyStatement = {
  /** In rupees, date order, with the running balance; for a vendor, bills credit the account as theirs does. */
  lines: LedgerEntry[];
  /** Rupees: invoices (bills) raised, payments, credit notes — what was written, at each one's rate. */
  invoiced: number;
  received: number;
  credited: number;
  /** Rupees still owed on invoices (bills), never below nothing on any one. */
  outstanding: number;
  /** Rupees on account: payments not set against anything (with any overpayment), and credit notes not used. */
  unappliedPayments: number;
  unappliedCredits: number;
  /** Opening balances and journals naming the party, owed-positive. */
  journals: number;
  /** outstanding − unapplied + journals: what the ledger holds for them. Negative: in credit. */
  balance: number;
  aging: Record<AgingBucket, number>;
  openDocuments: OpenDocument[];
  currencies: CurrencyBalance[];
};

const r2 = (n: number, rate: number) => round2(n * rate);
const sum = (rows: { amount: Prisma.Decimal | number }[]) => rows.reduce((t, r) => t + Number(r.amount), 0);

/**
 * The statement for a customer (`AR`) or a vendor (`AP`). `from` and `to` (YYYY-MM-DD) narrow the lines —
 * with what came before \`from\` brought forward as an opening line — the figures stay as they stand today.
 */
export async function partyStatement(side: StatementSide, companyId: string, opts?: { from?: string; to?: string }): Promise<PartyStatement> {
  const ar = side === "AR";
  const account = await db.ledgerAccount.findUnique({ where: { systemKey: ar ? SYSTEM_ACCOUNTS.AR : SYSTEM_ACCOUNTS.AP }, select: { id: true } });

  const [docs, paymentRows, vendorCredits, journalLines] = await Promise.all([
    db.tradeDocument.findMany({
      where: { companyId, docType: { in: ar ? ["INVOICE", "CREDIT_NOTE"] : ["BILL"] }, status: { notIn: ["DRAFT", "CANCELLED"] } },
      orderBy: { issueDate: "asc" },
      select: {
        id: true, docNumber: true, docType: true, issueDate: true, dueDate: true, currency: true, exchangeRate: true, total: true, paidBefore: true,
        reference: true,
        payments: { select: { amount: true, paymentAmount: true, payment: { select: { id: true, paidOn: true, currency: true, exchangeRate: true } } } },
        creditsReceived: { where: { creditNote: { status: { not: "DRAFT" } } }, select: { amount: true } },
        creditsApplied: { select: { amount: true } },
        vendorCredits: { select: { amount: true } },
      },
    }),
    db.payment.findMany({
      where: { companyId, direction: ar ? "RECEIVED" : "PAID" },
      orderBy: { paidOn: "asc" },
      select: { id: true, paymentSeq: true, amount: true, currency: true, exchangeRate: true, paidOn: true, method: true, reference: true, allocations: { select: { documentId: true, amount: true, paymentAmount: true } } },
    }),
    // A distributor's or an OEM's credit note takes what we owe them down; a payout into the bank never
    // touches their account.
    ar
      ? Promise.resolve([])
      : db.vendorCredit.findMany({
          where: { vendorId: companyId, form: "CREDIT_NOTE", cancelledAt: null },
          select: { id: true, reference: true, date: true, total: true, applications: { select: { amount: true } } },
        }),
    account
      ? db.journalLine.findMany({
          where: { accountId: account.id, companyId, entry: PERSON_ENTRY },
          select: { id: true, debit: true, credit: true, narration: true, entry: { select: { id: true, entryNumber: true, date: true, narration: true } } },
        })
      : Promise.resolve([]),
  ]);

  // What came across from the old system came with what was left on it (src/lib/documents/imported.ts).
  const across = (d: { total: Prisma.Decimal; paidBefore: Prisma.Decimal }) => Number(d.total) - Number(d.paidBefore);
  const live = new Set(docs.map((d) => d.id));
  const isCreditNote = (d: { docType: string }) => d.docType === "CREDIT_NOTE";

  // The figures, by the balance summary's own arithmetic.
  const documents: TieOutDocument[] = [
    ...docs.map((d) => ({
      id: d.id,
      docNumber: d.docNumber,
      docType: d.docType as TieOutDocument["docType"],
      companyId,
      companySeq: 0,
      companyName: "",
      currency: d.currency,
      rate: bookingRate(d),
      total: across(d),
      allocated: round2(sum(d.payments)),
      credited: round2(sum(d.creditsReceived) + sum(d.vendorCredits)),
      applied: round2(sum(d.creditsApplied)),
      posted: 0,
      hasEntry: true,
      entryNumbers: [],
    })),
    ...vendorCredits.map((c) => ({
      id: c.id,
      docNumber: c.reference,
      docType: "VENDOR_CREDIT" as const,
      companyId,
      companySeq: 0,
      companyName: "",
      currency: "INR",
      rate: 1,
      total: Number(c.total),
      allocated: 0,
      credited: 0,
      applied: round2(sum(c.applications)),
      posted: 0,
      hasEntry: true,
      entryNumbers: [],
    })),
  ];
  const payments: TieOutPayment[] = paymentRows.map((p) => ({
    id: p.id,
    label: `Payment #${p.paymentSeq}`,
    companyId,
    companySeq: 0,
    companyName: "",
    currency: p.currency,
    rate: bookingRate(p),
    amount: Number(p.amount),
    applied: round2(p.allocations.filter((a) => a.documentId && live.has(a.documentId)).reduce((t, a) => t + takenFromPayment(a), 0)),
  }));
  const owed = (l: { debit: Prisma.Decimal; credit: Prisma.Decimal }) => (ar ? Number(l.debit) - Number(l.credit) : Number(l.credit) - Number(l.debit));
  const journals: JournalAmount[] = journalLines.map((l) => ({ companyId, companySeq: 0, name: "", amount: owed(l) }));
  const row = summariseBalances({ documents, payments, journals }).rows[0];

  // The lines, owed-positive: `up` adds to what is owed, `down` takes it away.
  type Line = Omit<LedgerEntry, "balance" | "debit" | "credit"> & { up: number; down: number };
  const lines: Line[] = [];
  const foreignOf = (currency: string, amount: number) => (isBaseCurrency(currency) ? null : { currency, amount: round2(amount) });
  for (const d of docs) {
    const rate = bookingRate(d);
    const amount = across(d);
    const before = Number(d.paidBefore) > 0 ? ` (${Number(d.paidBefore).toLocaleString("en-IN")} ${isCreditNote(d) ? "used" : ar ? "settled" : "paid"} before Deskzo)` : "";
    lines.push({
      id: d.id,
      date: d.issueDate,
      kind: isCreditNote(d) ? "CREDIT_NOTE" : "INVOICE",
      reference: d.docNumber,
      description: (isCreditNote(d) ? "Credit note" : ar ? "Tax invoice" : d.reference ? `Bill · ref ${d.reference}` : "Bill") + before,
      up: isCreditNote(d) ? 0 : r2(amount, rate),
      down: isCreditNote(d) ? r2(amount, rate) : 0,
      href: `/documents/${d.id}`,
      foreign: foreignOf(d.currency, amount),
    });
    // Settled at another rate than it was raised at: the difference the ledger books on the payment's day.
    for (const a of d.payments) {
      const difference = settlementDifference(
        { amount: Number(a.amount), paymentAmount: a.paymentAmount === null ? null : Number(a.paymentAmount) },
        a.payment,
        d,
      );
      if (difference === null || Math.abs(difference) < 0.01) continue;
      lines.push({
        id: `${d.id}:${a.payment.id}`,
        date: a.payment.paidOn,
        kind: "EXCHANGE",
        reference: d.docNumber,
        description: `Exchange difference — settled at ${bookingRate(a.payment)} against ${rate}`,
        up: Math.max(difference, 0),
        down: Math.max(-difference, 0),
        href: `/documents/${d.id}`,
        foreign: null,
      });
    }
  }
  for (const c of vendorCredits) {
    lines.push({ id: c.id, date: c.date, kind: "CREDIT_NOTE", reference: c.reference, description: "Vendor credit note", up: 0, down: Number(c.total), href: `/purchase/vendor-credits/${c.id}`, foreign: null });
  }
  for (const p of paymentRows) {
    lines.push({
      id: p.id,
      date: p.paidOn,
      kind: "PAYMENT",
      reference: p.reference ?? p.method.replaceAll("_", " "),
      description: ar ? "Payment received" : "Payment made",
      up: 0,
      down: r2(Number(p.amount), bookingRate(p)),
      href: null,
      foreign: foreignOf(p.currency, Number(p.amount)),
    });
  }
  for (const l of journalLines) {
    const amount = owed(l);
    lines.push({
      id: l.id,
      date: l.entry.date,
      kind: "JOURNAL",
      reference: l.entry.entryNumber,
      description: l.narration || l.entry.narration,
      up: Math.max(amount, 0),
      down: Math.max(-amount, 0),
      href: `/accounting/journal?q=${encodeURIComponent(l.entry.entryNumber)}`,
      foreign: null,
    });
  }

  // A period: what came before it brought forward on its first day, what came after left out. A line's
  // date is a typed day (held at UTC midnight), or an entry's moment — compared by its calendar day.
  const days = calendarDayRange(opts?.from, opts?.to);
  const dayOf = (d: Date) => calendarDateOf(d).getTime();
  const inPeriod: Line[] = [];
  let carried = 0;
  for (const l of lines) {
    if (days?.gte && dayOf(l.date) < days.gte.getTime()) carried = round2(carried + l.up - l.down);
    else if (!(days?.lte && dayOf(l.date) > days.lte.getTime())) inPeriod.push(l);
  }
  if (days?.gte && Math.abs(carried) >= 0.005) {
    inPeriod.push({ id: "opening", date: days.gte, kind: "OPENING", reference: "Brought forward", description: "Balance before this period", up: Math.max(carried, 0), down: Math.max(-carried, 0), href: null, foreign: null });
  }
  // On one day: what was brought forward, then documents and journals, then payments, then the exchange
  // difference each payment left.
  const order = (l: Line) => (l.kind === "OPENING" ? 0 : l.kind === "PAYMENT" ? 2 : l.kind === "EXCHANGE" ? 3 : 1);
  inPeriod.sort((a, b) => dayOf(a.date) - dayOf(b.date) || order(a) - order(b));
  // A customer's account is debited by what they owe; a vendor's, as their own books keep it, credited.
  const ledger = withRunningBalance(inPeriod.map(({ up, down, ...l }) => ({ ...l, debit: ar ? up : down, credit: ar ? down : up })));

  // The ageing and the open documents, in rupees, from the same per-document arithmetic as the summary.
  const asOf = new Date();
  const aging = emptyAging();
  const openDocuments: OpenDocument[] = [];
  const perCurrency = new Map<string, { open: number; unused: number }>();
  const inCurrency = (currency: string) => {
    let c = perCurrency.get(currency);
    if (!c) perCurrency.set(currency, (c = { open: 0, unused: 0 }));
    return c;
  };
  for (const d of docs) {
    const doc = documents.find((x) => x.id === d.id)!;
    if (isCreditNote(d)) {
      const left = round2(doc.total - doc.applied);
      if (!isBaseCurrency(d.currency) && Math.abs(left) >= 0.005) inCurrency(d.currency).unused += left;
      continue;
    }
    const left = round2(doc.total - doc.allocated - doc.credited);
    const rupees = round2(r2(doc.total, doc.rate) - r2(doc.allocated, doc.rate) - r2(doc.credited, doc.rate));
    if (!isBaseCurrency(d.currency)) {
      if (left > 0.005) inCurrency(d.currency).open += left;
      else if (left < -0.005) inCurrency(d.currency).unused -= left;
    }
    if (rupees <= 0.005) continue;
    const bucket = agingBucket(d.dueDate, d.issueDate, asOf);
    aging[bucket] = round2(aging[bucket] + rupees);
    openDocuments.push({ id: d.id, docNumber: d.docNumber, issueDate: d.issueDate, dueDate: d.dueDate, balance: left, currency: d.currency, rupees, daysOverdue: daysOverdue(d.dueDate, d.issueDate, asOf), bucket });
  }
  for (const p of payments) {
    const left = round2(p.amount - p.applied);
    if (!isBaseCurrency(p.currency) && Math.abs(left) >= 0.005) inCurrency(p.currency).unused += left;
  }
  const currencies: CurrencyBalance[] = [...perCurrency.entries()]
    .map(([currency, c]) => ({ currency, open: round2(c.open), unused: round2(c.unused), balance: round2(c.open - c.unused) }))
    .filter((c) => Math.abs(c.open) >= 0.01 || Math.abs(c.unused) >= 0.01)
    .sort((a, b) => a.currency.localeCompare(b.currency));

  const unappliedCredits = round2(
    documents.filter((d) => d.docType === "CREDIT_NOTE" || d.docType === "VENDOR_CREDIT").reduce((t, d) => t + r2(d.total, d.rate) - r2(d.applied, d.rate), 0),
  );
  return {
    lines: ledger,
    invoiced: round2(docs.filter((d) => !isCreditNote(d)).reduce((t, d) => t + r2(across(d), bookingRate(d)), 0)),
    received: round2(paymentRows.reduce((t, p) => t + r2(Number(p.amount), bookingRate(p)), 0)),
    credited: round2(
      docs.filter(isCreditNote).reduce((t, d) => t + r2(across(d), bookingRate(d)), 0) + vendorCredits.reduce((t, c) => t + Number(c.total), 0),
    ),
    outstanding: row?.open ?? 0,
    // The rest of what the summary calls unused: payments not applied, and any invoice paid over.
    unappliedPayments: round2((row?.unused ?? 0) - unappliedCredits),
    unappliedCredits,
    journals: row?.journals ?? 0,
    balance: row?.balance ?? 0,
    aging,
    openDocuments: openDocuments.sort((a, b) => b.daysOverdue - a.daysOverdue),
    currencies,
  };
}
