import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { round2 } from "@/lib/close/checks";
import { PERSON_ENTRY, subledgerAt, TIE_OUT_TOLERANCE, type SubledgerScope, type TieOutDocument, type TieOutPayment, type TieOutSide } from "@/lib/close/tieout";
import { indiaClock } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { companyAccess } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";

/**
 * What each customer owes us, or we owe each vendor, as of a day (owner, 21 Oct 2026 — Zoho Books'
 * Customer and Vendor Balance Summary). One row a party:
 *
 *   · **Open invoices** (bills, for a vendor): what is left on each, in rupees at the rate it was raised at.
 *   · **Unused credits**: money not set against anything yet — a payment not applied, a credit note not
 *     used, an invoice paid more than it was for. Shown on its own, as the owner chose, rather than
 *     quietly taken off the invoices.
 *   · **Journals**: opening balances and journal entries on the account naming the party — the opening
 *     balances import puts a customer's balance there when its invoices weren't brought across.
 *   · **Balance**: the three netted, which is what Accounts Receivable (or Payable) in the ledger holds for
 *     the party. Negative: they are in credit with us.
 *   · And the balance in each foreign currency the party deals in, as the documents and payments were
 *     written — Zoho's "(FCY)".
 *
 * Counted by the close's own rules (`subledgerAt`, src/lib/close/tieout.ts): a document once issued by the
 * day, a cancelled one while its posting still stood, one brought from the old system from its opening
 * entry; a payment once dated by the day, with what it had been set against by then. The day ends at
 * midnight India time, as the books' days do.
 */

export type BalanceSide = TieOutSide;

export type PartyBalance = {
  id: string;
  companySeq: number;
  name: string;
  /** Open invoices or bills, in rupees. */
  open: number;
  /** How many of them. */
  documents: number;
  /** Payments, credit notes and overpayments not set against anything, in rupees — a positive figure. */
  unused: number;
  /** Opening balances and journal entries naming the party, owed-positive, in rupees. */
  journals: number;
  /** open − unused + journals. */
  balance: number;
  /** The balance in each currency other than rupees, as written. */
  foreign: { currency: string; amount: number }[];
  /** What the ledger holds for the party, when compared; null otherwise. */
  ledger: number | null;
};

export type BalanceTotals = { open: number; unused: number; journals: number; balance: number };

export type JournalAmount = { companyId: string; companySeq: number; name: string; amount: number };

const r2 = (n: number, rate: number) => round2(n * rate);
const isCredit = (doc: TieOutDocument) => doc.docType === "CREDIT_NOTE" || doc.docType === "VENDOR_CREDIT";
const isRupees = (currency: string) => currency.toUpperCase() === "INR";

/**
 * The rows, from what the subledger and the journals hold — pure, so check:balance-summary can pin every
 * case. `ledger` (each party's balance there) is given only to compare; a party the ledger has a balance
 * for and nothing else does is listed too, so a difference never hides.
 */
export function summariseBalances(input: {
  documents: TieOutDocument[];
  payments: TieOutPayment[];
  journals: JournalAmount[];
  ledger?: Map<string, { companySeq: number; name: string; amount: number }> | null;
}): { rows: PartyBalance[]; totals: BalanceTotals } {
  type Acc = Omit<PartyBalance, "foreign" | "balance" | "ledger"> & { foreign: Map<string, number> };
  const parties = new Map<string, Acc>();
  const party = (id: string, companySeq: number, name: string): Acc => {
    let row = parties.get(id);
    if (!row) {
      row = { id, companySeq, name, open: 0, documents: 0, unused: 0, journals: 0, foreign: new Map() };
      parties.set(id, row);
    }
    return row;
  };
  const addForeign = (row: Acc, currency: string, amount: number) => {
    if (isRupees(currency) || Math.abs(amount) < 0.005) return;
    row.foreign.set(currency, round2((row.foreign.get(currency) ?? 0) + amount));
  };

  for (const doc of input.documents) {
    if (isCredit(doc)) {
      const left = round2(doc.total - doc.applied);
      const rupees = round2(r2(doc.total, doc.rate) - r2(doc.applied, doc.rate));
      if (Math.abs(left) < 0.005 && Math.abs(rupees) < 0.005) continue;
      const row = party(doc.companyId, doc.companySeq, doc.companyName);
      row.unused = round2(row.unused + rupees);
      addForeign(row, doc.currency, -left);
      continue;
    }
    const left = round2(doc.total - doc.allocated - doc.credited);
    const rupees = round2(r2(doc.total, doc.rate) - r2(doc.allocated, doc.rate) - r2(doc.credited, doc.rate));
    if (Math.abs(left) < 0.005 && Math.abs(rupees) < 0.005) continue;
    const row = party(doc.companyId, doc.companySeq, doc.companyName);
    // Paid more than it was for: the extra is money on account, not a negative invoice.
    if (rupees > 0) {
      row.open = round2(row.open + rupees);
      row.documents += 1;
    } else row.unused = round2(row.unused - rupees);
    addForeign(row, doc.currency, left);
  }

  for (const p of input.payments) {
    const left = round2(p.amount - p.applied);
    if (Math.abs(left) < 0.005) continue;
    const row = party(p.companyId, p.companySeq, p.companyName);
    row.unused = round2(row.unused + r2(left, p.rate));
    addForeign(row, p.currency, -left);
  }

  for (const j of input.journals) {
    if (Math.abs(j.amount) < 0.005) continue;
    const row = party(j.companyId, j.companySeq, j.name);
    row.journals = round2(row.journals + j.amount);
  }

  if (input.ledger) for (const [id, l] of input.ledger) if (Math.abs(l.amount) >= 0.01) party(id, l.companySeq, l.name);

  const rows: PartyBalance[] = [...parties.values()]
    .map((row) => ({
      ...row,
      balance: round2(row.open - row.unused + row.journals),
      foreign: [...row.foreign.entries()].filter(([, amount]) => Math.abs(amount) >= 0.01).map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)),
      ledger: input.ledger ? round2(input.ledger.get(row.id)?.amount ?? 0) : null,
    }))
    .filter((row) => Math.abs(row.open) >= 0.01 || Math.abs(row.unused) >= 0.01 || Math.abs(row.journals) >= 0.01 || (row.ledger !== null && Math.abs(row.ledger) >= 0.01))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));

  const totals = rows.reduce<BalanceTotals>(
    (t, r) => ({ open: round2(t.open + r.open), unused: round2(t.unused + r.unused), journals: round2(t.journals + r.journals), balance: round2(t.balance + r.balance) }),
    { open: 0, unused: 0, journals: 0, balance: 0 },
  );
  return { rows, totals };
}

/** A party's balance and the ledger's differ by more than the close allows. */
export const differsFromLedger = (row: PartyBalance) => row.ledger !== null && Math.abs(row.balance - row.ledger) > TIE_OUT_TOLERANCE;

export type BalanceSummary = {
  side: BalanceSide;
  /** The day, YYYY-MM-DD. */
  asOf: string;
  rows: PartyBalance[];
  totals: BalanceTotals;
  /** Compared with the ledger (for somebody who may read the books): the account, and the parties that differ. */
  ledger: { accountId: string; differing: number } | null;
};

/**
 * Loads the summary as of the end of `asOf` (India's day). `scope` narrows it to what one person may see:
 * their documents and payments, and the parties (`companies`) whose journal lines and vendor credit notes
 * they reach. `compareLedger`: also read each party's balance in the ledger.
 */
export async function loadBalanceSummary(
  side: BalanceSide,
  asOf: string,
  options: { scope?: SubledgerScope & { companies?: Prisma.CompanyWhereInput }; compareLedger?: boolean } = {},
): Promise<BalanceSummary> {
  const to = indiaClock.endOfDay(asOf);
  if (!to) throw new Error(`Not a day: ${asOf}`);
  const scope = options.scope ?? {};
  const { accountId, documents, payments } = await subledgerAt(side, to, { documents: scope.documents, payments: scope.payments, vendors: scope.companies });
  if (!accountId) return { side, asOf, ...summariseBalances({ documents, payments, journals: [] }), ledger: null };

  const owed = (l: { debit: Prisma.Decimal; credit: Prisma.Decimal }) => (side === "AR" ? Number(l.debit) - Number(l.credit) : Number(l.credit) - Number(l.debit));
  const company = scope.companies && Object.keys(scope.companies).length > 0 ? { company: scope.companies } : {};
  const lines = await db.journalLine.findMany({
    where: { accountId, companyId: { not: null }, entry: { ...PERSON_ENTRY, date: { lt: to } }, ...company },
    select: { debit: true, credit: true, companyId: true, company: { select: { companySeq: true, name: true } } },
  });
  const journals: JournalAmount[] = lines.map((l) => ({ companyId: l.companyId!, companySeq: l.company!.companySeq, name: l.company!.name, amount: owed(l) }));

  let ledger: Map<string, { companySeq: number; name: string; amount: number }> | null = null;
  if (options.compareLedger) {
    const sums = await db.journalLine.groupBy({
      by: ["companyId"],
      where: { accountId, companyId: { not: null }, entry: { date: { lt: to } }, ...company },
      _sum: { debit: true, credit: true },
    });
    const ids = sums.map((s) => s.companyId!).filter(Boolean);
    const names = ids.length ? await db.company.findMany({ where: { id: { in: ids } }, select: { id: true, companySeq: true, name: true } }) : [];
    const byId = new Map(names.map((c) => [c.id, c]));
    ledger = new Map(
      sums
        .filter((s) => s.companyId && byId.has(s.companyId))
        .map((s) => {
          const c = byId.get(s.companyId!)!;
          const debit = Number(s._sum.debit ?? 0);
          const credit = Number(s._sum.credit ?? 0);
          return [s.companyId!, { companySeq: c.companySeq, name: c.name, amount: round2(side === "AR" ? debit - credit : credit - debit) }];
        }),
    );
  }

  const { rows, totals } = summariseBalances({ documents, payments, journals, ledger });
  return { side, asOf, rows, totals, ledger: ledger ? { accountId, differing: rows.filter(differsFromLedger).length } : null };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The summary as one person may see it — what the Receivables and Payables pages show. The customers and
 * vendors they reach (the access engine, `companyAccess`), each counted whole: a balance is the party's,
 * and counting only the invoices one may open would show a customer with a payment and no invoice as in
 * credit. That is \`payments.view\`'s to give — "money in and owed … the billed and outstanding figures" —
 * which the caller has checked, with the module. Compared with the ledger only for somebody who may read
 * the books, since it says what the ledger holds. `asOf` defaults to the workspace's today; `search`
 * narrows the rows by name, and the totals with them.
 */
export async function balanceSummaryFor(userId: string, side: BalanceSide, params?: { asOf?: string; search?: string }): Promise<BalanceSummary> {
  const asOf = params?.asOf && DAY.test(params.asOf) && indiaClock.endOfDay(params.asOf) ? params.asOf : (await workspaceClock()).today();
  const [companies, books] = await Promise.all([
    companyAccess(userId, "view"),
    (async () => (await moduleAccessFor(userId, "accounting")) === "available" && (await can(userId, "ledger.viewReports")))(),
  ]);
  const reached = Object.keys(companies).length > 0;
  const scope = reached ? { documents: { company: companies }, payments: { company: companies }, companies } : {};
  const summary = await loadBalanceSummary(side, asOf, { scope, compareLedger: books });
  const search = params?.search?.trim().toLowerCase();
  if (!search) return summary;
  const rows = summary.rows.filter((r) => r.name.toLowerCase().includes(search));
  const totals = rows.reduce<BalanceTotals>(
    (t, r) => ({ open: round2(t.open + r.open), unused: round2(t.unused + r.unused), journals: round2(t.journals + r.journals), balance: round2(t.balance + r.balance) }),
    { open: 0, unused: 0, journals: 0, balance: 0 },
  );
  return { ...summary, rows, totals, ledger: summary.ledger ? { ...summary.ledger, differing: rows.filter(differsFromLedger).length } : null };
}
