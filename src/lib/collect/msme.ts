import { db } from "@/lib/db";

/**
 * Interest on late payment to a micro or small enterprise (owner, 23 Oct 2026) — the MSMED Act, 2006:
 *
 *   · s.15: the buyer pays on the day agreed in writing, which can't be more than 45 days from acceptance;
 *     with nothing agreed, by the appointed day — 15 days from acceptance. The invoice's issue date stands in
 *     for acceptance, and its due date for the day agreed (capped at 45 days).
 *   · s.16: past that, compound interest with monthly rests at three times the bank rate the RBI notifies.
 *
 * Worked out day by day: the unpaid principal (less payments and credit notes, each on its own date) earns
 * a day's interest at the annual rate / 365; at each month's rest the interest so far joins what earns. It
 * runs to the day the principal is cleared, or to today. Shown, never billed on its own — "Charge interest"
 * raises a debit note when the business decides to (the debit note carries the GST).
 */

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** A calendar day as a `@db.Date` holds one: midnight UTC. */
const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export type InterestInput = {
  issueDate: Date;
  dueDate: Date | null;
  /** What the invoice was for, less anything settled before Deskzo. */
  principal: number;
  /** Payments and credit notes, each on its own day. */
  settlements: { on: Date; amount: number }[];
};

export type InterestWorked = {
  /** The last day to pay without interest. */
  lastDay: Date;
  /** Days interest ran for. */
  days: number;
  interest: number;
  /** What was still unpaid when interest stopped (0 once it was settled). */
  unpaid: number;
  /** The annual rate used, % — three times the bank rate. */
  rate: number;
};

/** The last day the Act gives to pay: the agreed due date, at most 45 days after issue; 15 days with none agreed. */
export function lastDayToPay(issueDate: Date, dueDate: Date | null): Date {
  const issued = dayOf(issueDate).getTime();
  const cap = issued + 45 * DAY;
  if (!dueDate) return new Date(issued + 15 * DAY);
  return new Date(Math.min(dayOf(dueDate).getTime(), cap));
}

/** Adds `months` calendar months to a day, holding the day of the month where the month has it. */
function addMonths(d: Date, months: number): Date {
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), last)));
}

export function msmeInterest(input: InterestInput, asOf: Date, bankRatePercent: number): InterestWorked {
  const rate = round2(bankRatePercent * 3);
  const lastDay = lastDayToPay(input.issueDate, input.dueDate);
  const start = new Date(lastDay.getTime() + DAY);
  const end = dayOf(asOf);
  const settlements = input.settlements.map((s) => ({ on: dayOf(s.on).getTime(), amount: s.amount })).sort((a, b) => a.on - b.on);

  // Principal unpaid at the start of a day: everything settled on an earlier day is off it.
  let unpaid = input.principal;
  let next = 0;
  const settleUpTo = (time: number) => {
    while (next < settlements.length && settlements[next]!.on < time) unpaid -= settlements[next++]!.amount;
  };
  settleUpTo(start.getTime());
  if (unpaid <= 0.005 || end.getTime() < start.getTime() || rate <= 0) return { lastDay, days: 0, interest: 0, unpaid: Math.max(round2(unpaid), 0), rate };

  const daily = rate / 100 / 365;
  let capitalised = 0;
  let accrued = 0;
  let rest = addMonths(start, 1);
  let restsPassed = 1;
  let days = 0;
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    if (t >= rest.getTime()) {
      // A monthly rest: the month's interest joins what earns interest.
      capitalised += accrued;
      accrued = 0;
      restsPassed += 1;
      rest = addMonths(start, restsPassed);
    }
    settleUpTo(t + DAY);
    // Paid off on this day: no interest for it, nor after.
    if (unpaid <= 0.005) break;
    accrued += (unpaid + capitalised) * daily;
    days += 1;
  }
  return { lastDay, days, interest: round2(capitalised + accrued), unpaid: Math.max(round2(unpaid), 0), rate };
}

/** An invoice's facts for the sum above, read from the books. */
export async function interestInputFor(invoiceId: string): Promise<(InterestInput & { docNumber: string | null; total: number; companyId: string }) | null> {
  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: {
      docType: true,
      status: true,
      docNumber: true,
      companyId: true,
      issueDate: true,
      dueDate: true,
      total: true,
      paidBefore: true,
      payments: { select: { amount: true, payment: { select: { paidOn: true } } } },
      creditsReceived: { select: { amount: true, creditNote: { select: { issueDate: true } } } },
    },
  });
  if (!invoice || invoice.docType !== "INVOICE" || invoice.status === "DRAFT" || invoice.status === "CANCELLED") return null;
  return {
    docNumber: invoice.docNumber,
    companyId: invoice.companyId,
    total: Number(invoice.total),
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    principal: Number(invoice.total) - Number(invoice.paidBefore),
    settlements: [
      ...invoice.payments.map((p) => ({ on: p.payment.paidOn, amount: Number(p.amount) })),
      ...invoice.creditsReceived.map((c) => ({ on: c.creditNote.issueDate, amount: Number(c.amount) })),
    ],
  };
}

export type InterestRow = {
  invoiceId: string;
  docNumber: string | null;
  issueDate: Date;
  total: number;
  lastDay: Date;
  /** Still unpaid now; 0 for an invoice paid late, whose interest stopped the day it was cleared. */
  unpaid: number;
  days: number;
  interest: number;
  rate: number;
};

/**
 * A customer's invoices that were, or are, paid late, with the interest on each — the open ones, and those
 * cleared in the last `months` months (a Samadhaan claim can go back further; this is what the screen shows).
 */
export async function interestForCompany(companyId: string, bankRatePercent: number, asOf: Date = new Date(), months = 12): Promise<InterestRow[]> {
  const since = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - months - 2, 1));
  const invoices = await db.tradeDocument.findMany({
    where: { companyId, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] }, issueDate: { gte: since } },
    orderBy: { issueDate: "asc" },
    take: 2000,
    select: {
      id: true,
      docNumber: true,
      issueDate: true,
      dueDate: true,
      total: true,
      paidBefore: true,
      payments: { select: { amount: true, payment: { select: { paidOn: true } } } },
      creditsReceived: { select: { amount: true, creditNote: { select: { issueDate: true } } } },
    },
  });
  const rows: InterestRow[] = [];
  for (const i of invoices) {
    const worked = msmeInterest(
      {
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        principal: Number(i.total) - Number(i.paidBefore),
        settlements: [
          ...i.payments.map((p) => ({ on: p.payment.paidOn, amount: Number(p.amount) })),
          ...i.creditsReceived.map((c) => ({ on: c.creditNote.issueDate, amount: Number(c.amount) })),
        ],
      },
      asOf,
      bankRatePercent,
    );
    if (worked.interest < 1) continue;
    rows.push({ invoiceId: i.id, docNumber: i.docNumber, issueDate: i.issueDate, total: Number(i.total), lastDay: worked.lastDay, unpaid: worked.unpaid, days: worked.days, interest: worked.interest, rate: worked.rate });
  }
  return rows;
}
