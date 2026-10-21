import type { Prisma } from "@prisma/client";
import { round2 } from "@/lib/close/checks";
import { subledgerAt, type TieOutDocument, type TieOutSide } from "@/lib/close/tieout";
import { documentAccess } from "@/lib/authz/access";
import { indiaClock } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The aging report, both sides (owner, 21 Oct 2026 — Zoho Books' "AR/AP Aging Summary"): what was open on
 * each invoice or bill at the end of a chosen day, in columns by how old it was then.
 *
 *   · **As of** any day — counted by the close's own rules (`subledgerAt`, src/lib/close/tieout.ts), so a
 *     payment dated after the day, or a credit note applied after it, doesn't count yet. The day ends at
 *     midnight India time, as the books' days do.
 *   · **Aged by** the due date (the first column is "Current": not yet due) or by the document's own date
 *     (the first column starts at 0 days). A document with no due date ages from its date either way.
 *   · **Intervals** of a chosen length and number — 4 × 15 days, 4 × 30 … — and one past the last.
 *   · In rupees at each document's own rate, as Accounts Receivable (Payable) holds it; what is left in
 *     any other currency, as written, beside it — Zoho's "(FCY)".
 *   · Every document behind a figure (the details view), so each amount on the summary opens its list.
 *   · Optionally only the invoices (bills) **dated** from one day to another (owner, 21 Oct 2026) — "April's
 *     invoices, and what was still open on them as of today". Their age and what was left on them are still
 *     as of the As of day; one dated after it hadn't been raised yet then, so isn't counted.
 *
 * Only invoices and bills are aged: payments not set against anything and credit notes not used are the
 * Balance summary's (src/lib/receivables/balance-summary.ts), and an invoice paid more than it was for
 * shows there as money on account rather than here as a negative age. Who sees what is the document
 * lists' rule (`documentAccess`), as the Aged view's — every figure opens to documents the person may open.
 */

export type AgingSide = TieOutSide;
export type AgingBasis = "due" | "date";

export const AGING_INTERVALS = [
  { key: "4x15", count: 4, days: 15 },
  { key: "4x30", count: 4, days: 30 },
  { key: "3x30", count: 3, days: 30 },
  { key: "6x30", count: 6, days: 30 },
  { key: "4x45", count: 4, days: 45 },
  { key: "4x90", count: 4, days: 90 },
] as const;
export type AgingIntervalKey = (typeof AGING_INTERVALS)[number]["key"];
/** The Aged view's columns — 30 days at a time — so the two read alike until somebody picks others. */
export const DEFAULT_INTERVAL: AgingIntervalKey = "4x30";

export const intervalLabel = (key: AgingIntervalKey) => {
  const i = AGING_INTERVALS.find((x) => x.key === key)!;
  return `${i.count} × ${i.days} days`;
};

/** One column: the ages in it, both ends in; `from` null — anything not yet due; `to` null — anything older. */
export type AgingColumn = { label: string; from: number | null; to: number | null };

/**
 * The columns, as Zoho counts them: "4 × 15 days" is four intervals, the last open-ended — 1–15, 16–30,
 * 31–45, > 45 — after "Current" (not yet due) when aged by due date, or from 0 days when aged by the
 * document's date. 4 × 30 by due date is the Aged view's own columns.
 */
export function agingColumns(basis: AgingBasis, key: AgingIntervalKey): AgingColumn[] {
  const { count, days } = AGING_INTERVALS.find((x) => x.key === key)!;
  const columns: AgingColumn[] = basis === "due" ? [{ label: "Current", from: null, to: 0 }] : [];
  for (let i = 0; i < count - 1; i += 1) {
    const from = basis === "date" && i === 0 ? 0 : i * days + 1;
    columns.push({ label: `${from}–${(i + 1) * days} days`, from, to: (i + 1) * days });
  }
  columns.push({ label: `> ${(count - 1) * days} days`, from: (count - 1) * days + 1, to: null });
  return columns;
}

/** Which column an age falls in. */
export function columnOf(age: number, columns: AgingColumn[]): number {
  const i = columns.findIndex((c) => (c.from === null || age >= c.from) && (c.to === null || age <= c.to));
  return i < 0 ? 0 : i;
}

const DAY_MS = 86_400_000;
/** A typed day (UTC midnight) as YYYY-MM-DD. */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

/**
 * How many days old a document was at the end of `asOf` (YYYY-MM-DD): days past its due date, or since
 * its date. Calendar days — both are typed days held at UTC midnight — so the hour of day never moves one.
 */
export function ageOn(asOf: string, basis: AgingBasis, issueDate: Date, dueDate: Date | null | undefined): number {
  const from = basis === "due" && dueDate ? dueDate : issueDate;
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dayKey(from)}T00:00:00Z`)) / DAY_MS);
}

/** One open invoice or bill, as it stood: what the details view lists. */
export type AgedDocument = {
  id: string;
  docNumber: string;
  companyId: string;
  companySeq: number;
  party: string;
  issueDate: string;
  dueDate: string | null;
  age: number;
  column: number;
  /** Left on it, in rupees at its own rate. */
  balance: number;
  /** Left on it in its own currency, and that currency. */
  left: number;
  currency: string;
};

const isRupees = (currency: string) => currency.toUpperCase() === "INR";

/**
 * The open invoices and bills among the subledger's documents, aged — pure, so check:aging-report pins it.
 * Credit notes are left out (see above), and a document with nothing left, or paid more than it was for.
 */
export function ageDocuments(input: { documents: TieOutDocument[]; asOf: string; basis: AgingBasis; columns: AgingColumn[] }): AgedDocument[] {
  const out: AgedDocument[] = [];
  for (const doc of input.documents) {
    if (doc.docType !== "INVOICE" && doc.docType !== "BILL") continue;
    const left = round2(doc.total - doc.allocated - doc.credited);
    const balance = round2(round2(doc.total * doc.rate) - round2(doc.allocated * doc.rate) - round2(doc.credited * doc.rate));
    if (balance < 0.01) continue;
    const issueDate = doc.issueDate ?? new Date(`${input.asOf}T00:00:00Z`);
    const age = ageOn(input.asOf, input.basis, issueDate, doc.dueDate);
    out.push({
      id: doc.id,
      docNumber: doc.docNumber,
      companyId: doc.companyId,
      companySeq: doc.companySeq,
      party: doc.companyName,
      issueDate: dayKey(issueDate),
      dueDate: doc.dueDate ? dayKey(doc.dueDate) : null,
      age,
      column: columnOf(age, input.columns),
      balance,
      left,
      currency: doc.currency,
    });
  }
  return out.sort((a, b) => b.age - a.age || a.party.localeCompare(b.party, "en", { sensitivity: "base" }) || a.docNumber.localeCompare(b.docNumber));
}

/** Only the documents dated from `from` to `to` (YYYY-MM-DD, both ends in; either may be open) — pure. */
export function datedWithin(documents: AgedDocument[], from: string | null, to: string | null): AgedDocument[] {
  if (!from && !to) return documents;
  return documents.filter((d) => (!from || d.issueDate >= from) && (!to || d.issueDate <= to));
}

export type AgingRow = {
  id: string;
  companySeq: number;
  name: string;
  /** Rupees in each column. */
  cells: number[];
  /** Documents in each column. */
  counts: number[];
  total: number;
  count: number;
  /** What is left in each currency other than rupees, as written. */
  foreign: { currency: string; amount: number }[];
};

export type AgingTotals = { cells: number[]; counts: number[]; total: number; count: number };

/** One row a party, alphabetical, and the totals — pure. */
export function summariseAging(documents: AgedDocument[], columns: number): { rows: AgingRow[]; totals: AgingTotals } {
  const parties = new Map<string, Omit<AgingRow, "foreign"> & { foreign: Map<string, number> }>();
  for (const d of documents) {
    let row = parties.get(d.companyId);
    if (!row) {
      row = { id: d.companyId, companySeq: d.companySeq, name: d.party, cells: Array(columns).fill(0), counts: Array(columns).fill(0), total: 0, count: 0, foreign: new Map() };
      parties.set(d.companyId, row);
    }
    row.cells[d.column] = round2(row.cells[d.column]! + d.balance);
    row.counts[d.column]! += 1;
    row.total = round2(row.total + d.balance);
    row.count += 1;
    if (!isRupees(d.currency)) row.foreign.set(d.currency, round2((row.foreign.get(d.currency) ?? 0) + d.left));
  }
  const rows: AgingRow[] = [...parties.values()]
    .map((r) => ({ ...r, foreign: [...r.foreign.entries()].map(([currency, amount]) => ({ currency, amount })).sort((a, b) => a.currency.localeCompare(b.currency)) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  const totals: AgingTotals = { cells: Array(columns).fill(0), counts: Array(columns).fill(0), total: 0, count: 0 };
  for (const r of rows) {
    r.cells.forEach((v, i) => (totals.cells[i] = round2(totals.cells[i]! + v)));
    r.counts.forEach((v, i) => (totals.counts[i]! += v));
    totals.total = round2(totals.total + r.total);
    totals.count += r.count;
  }
  return { rows, totals };
}

/** The report's settings, as the address carries them. */
export type AgingParams = { asOf?: string; from?: string; to?: string; by?: string; iv?: string; show?: string; q?: string; party?: string; col?: string };

export type AgingSettings = {
  asOf: string;
  /** Only documents dated from this day to that one (either may be open); null — every one. */
  datedFrom: string | null;
  datedTo: string | null;
  basis: AgingBasis;
  interval: AgingIntervalKey;
  show: "amount" | "count";
  search: string | null;
  /** The details view's: one party (its companySeq), one column. */
  party: number | null;
  column: number | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const readDay = (value: string | undefined) => (value && DAY.test(value) && indiaClock.endOfDay(value) ? value : null);

/** The address's settings, each checked; anything else falls back — today, every date, the due date, 4 × 30, amounts. */
export function readAgingParams(params: AgingParams | undefined, today: string): AgingSettings {
  const asOf = readDay(params?.asOf) ?? today;
  let datedFrom = readDay(params?.from);
  let datedTo = readDay(params?.to);
  // Typed the wrong way round, it means the same days.
  if (datedFrom && datedTo && datedFrom > datedTo) [datedFrom, datedTo] = [datedTo, datedFrom];
  const interval = (AGING_INTERVALS.find((i) => i.key === params?.iv)?.key ?? DEFAULT_INTERVAL) as AgingIntervalKey;
  const party = params?.party && /^\d{1,9}$/.test(params.party) ? Number(params.party) : null;
  const column = params?.col && /^\d{1,2}$/.test(params.col) ? Number(params.col) : null;
  return {
    asOf,
    datedFrom,
    datedTo,
    basis: params?.by === "date" ? "date" : "due",
    interval,
    show: params?.show === "count" ? "count" : "amount",
    search: params?.q?.trim() || null,
    party,
    column,
  };
}

export type AgingReport = {
  side: AgingSide;
  settings: AgingSettings;
  columns: AgingColumn[];
  rows: AgingRow[];
  totals: AgingTotals;
  /** Every open document behind the rows, oldest first — narrowed by the details view's party and column. */
  documents: AgedDocument[];
};

/** Loads the report as of the end of `settings.asOf`, over the documents `scope` lets through. */
export async function loadAging(side: AgingSide, settings: AgingSettings, scope: Prisma.TradeDocumentWhereInput = {}): Promise<AgingReport> {
  const to = indiaClock.endOfDay(settings.asOf);
  if (!to) throw new Error(`Not a day: ${settings.asOf}`);
  // Only documents are aged: no payments, no vendor credit notes (an empty `in` reads nothing).
  const { documents } = await subledgerAt(side, to, { documents: scope, payments: { id: { in: [] } }, vendors: { id: { in: [] } } });
  const columns = agingColumns(settings.basis, settings.interval);
  let aged = datedWithin(ageDocuments({ documents, asOf: settings.asOf, basis: settings.basis, columns }), settings.datedFrom, settings.datedTo);
  if (settings.search) {
    const s = settings.search.toLowerCase();
    aged = aged.filter((d) => d.party.toLowerCase().includes(s));
  }
  const { rows, totals } = summariseAging(aged, columns.length);
  const listed = aged.filter((d) => (settings.party === null || d.companySeq === settings.party) && (settings.column === null || d.column === settings.column));
  return { side, settings, columns, rows, totals, documents: listed };
}

/** The report as one person may see it: the invoices or bills they may open, as of their workspace's today unless a day is named. */
export async function agingReportFor(userId: string, side: AgingSide, params?: AgingParams): Promise<AgingReport> {
  const settings = readAgingParams(params, (await workspaceClock()).today());
  return loadAging(side, settings, await documentAccess(userId, "view"));
}

/** The summary and the documents as spreadsheet rows — the export (src/actions/receivable.ts, payable.ts). */
export function agingSheets(report: AgingReport): { name: string; rows: Record<string, unknown>[] }[] {
  const party = report.side === "AR" ? "Customer" : "Vendor";
  const fcy = (list: { currency: string; amount: number }[]) => list.map((f) => `${f.currency} ${f.amount.toFixed(2)}`).join("; ");
  const summary = report.rows.map((r) => ({
    [party]: r.name,
    ...Object.fromEntries(report.columns.map((c, i) => [c.label, report.settings.show === "count" ? r.counts[i] : r.cells[i]])),
    Total: report.settings.show === "count" ? r.count : r.total,
    "Total (FCY)": fcy(r.foreign),
  }));
  summary.push({
    [party]: "Total",
    ...Object.fromEntries(report.columns.map((c, i) => [c.label, report.settings.show === "count" ? report.totals.counts[i] : report.totals.cells[i]])),
    Total: report.settings.show === "count" ? report.totals.count : report.totals.total,
    "Total (FCY)": "",
  });
  const details = report.documents.map((d) => ({
    [party]: d.party,
    [report.side === "AR" ? "Invoice" : "Bill"]: d.docNumber,
    Date: d.issueDate,
    "Due date": d.dueDate ?? "",
    "Age (days)": d.age,
    Column: report.columns[d.column]?.label ?? "",
    "Balance (INR)": d.balance,
    "Balance (FCY)": isRupees(d.currency) ? "" : `${d.currency} ${d.left.toFixed(2)}`,
  }));
  return [
    { name: "Aging summary", rows: summary },
    { name: "Aging details", rows: details },
  ];
}
