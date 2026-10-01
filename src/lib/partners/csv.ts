import Papa from "papaparse";
import type { CommissionKind, CommissionStatus } from "@deskzo/control-client";
import { csvFilename } from "@/lib/console-shared/format";
import { COMMISSION_KIND, COMMISSION_STATUS } from "@/lib/console-shared/labels";
import type { CsvExport } from "@/lib/console-shared/types";
import { istDateTimeInput } from "@/lib/india-time";
import { PartnerRefused, type TaxLine } from "@/lib/partners/types";

/**
 * Commission and statement exports as CSV (spec §6.7) — for the console (with a Partner column) and
 * the portal (without). The loaders pick the rows; this only writes them.
 *
 *   · Amounts are in each currency's main unit (1499.00 rupees, not 149900 paise), beside their
 *     currency, as numbers — never added across currencies.
 *   · Text a spreadsheet would read as a formula is escaped; lines end in CRLF.
 *   · No email address, no bank detail, no tax id: company and workspace names, invoice numbers and
 *     amounts only (spec §12.5).
 *   · At most 10,000 rows; more is refused — narrow it down.
 */

/** The most rows one export may hold. Loaders read `CSV_MAX_ROWS + 1` to know when to refuse. */
export const CSV_MAX_ROWS = 10_000;

/** One commission entry as the exports write it. */
export type CommissionCsvRow = {
  earnedAt: Date;
  /** The partner's display name — written only when the export has the Partner column. */
  partner?: string | null;
  /** The customer's name and workspace slug; null for an adjustment about no one customer. */
  customer: string | null;
  workspace: string | null;
  /** The invoice's number (the gateway's), when it has one. */
  invoice: string | null;
  kind: CommissionKind;
  /** A reversal of an accrual (a refund, credit note or void): its kind reads "Direct — reversal". */
  reversal?: boolean;
  /** Minor units. */
  base: number;
  rateBp: number;
  /** Minor units: positive owed, negative clawed back. */
  amount: number;
  currency: string;
  status: CommissionStatus;
  statement: string | null;
};

/** What a statement export needs of the statement itself. Amounts in minor units. */
export type StatementCsvHead = { number: string; currency: string; total: number | bigint; netPayable: number | bigint; taxLines: TaxLine[] };

const COMMISSION_FIELDS = ["Earned (IST)", "Customer", "Workspace", "Invoice", "Kind", "Base", "Rate %", "Commission", "Currency", "Status", "Statement"];
const COMMISSION_AT = COMMISSION_FIELDS.indexOf("Commission");
const RATE_AT = COMMISSION_FIELDS.indexOf("Rate %");
const CURRENCY_AT = COMMISSION_FIELDS.indexOf("Currency");

/** How many decimal places a currency's amounts have: 2 for INR and USD, 0 for JPY (as src/lib/platform/revenue.ts). */
function minorDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function majorUnits(): (minor: number | bigint, currency: string) => number {
  const digits = new Map<string, number>();
  return (minor, currency) => {
    let d = digits.get(currency);
    if (d === undefined) {
      d = minorDigits(currency);
      digits.set(currency, d);
    }
    return Number((Number(minor) / 10 ** d).toFixed(d));
  };
}

/** A time as India's wall clock, sortable: "2026-09-27 18:30". */
const istStamp = (at: Date) => istDateTimeInput(at).replace("T", " ");

const ratePercent = (bp: number) => Number((bp / 100).toFixed(2));

function refuseOver(rows: number) {
  if (rows > CSV_MAX_ROWS) {
    throw new PartnerRefused(`That is ${rows.toLocaleString("en-IN")} entries — narrow it down to at most ${CSV_MAX_ROWS.toLocaleString("en-IN")} in one export.`);
  }
}

function cells(r: CommissionCsvRow, major: (minor: number | bigint, currency: string) => number): (string | number)[] {
  const currency = r.currency.trim().toUpperCase();
  const kind = COMMISSION_KIND[r.kind]?.label ?? r.kind;
  return [
    istStamp(r.earnedAt),
    r.customer ?? "",
    r.workspace ?? "",
    r.invoice ?? "",
    r.reversal ? `${kind} — reversal` : kind,
    major(r.base, currency),
    ratePercent(r.rateBp),
    major(r.amount, currency),
    currency,
    COMMISSION_STATUS[r.status]?.label ?? r.status,
    r.statement ?? "",
  ];
}

const unparse = (fields: string[], data: (string | number)[][]) => Papa.unparse({ fields, data }, { escapeFormulae: true, newline: "\r\n" });

/**
 * Commission entries as CSV. `withPartner` puts the partner's name first (the console's exports);
 * `filenamePrefix` names the file ("commissions", "acme-commissions"), dated today in India.
 */
export function commissionCsv(rows: CommissionCsvRow[], opts: { withPartner: boolean; filenamePrefix: string }, now: Date = new Date()): CsvExport {
  refuseOver(rows.length);
  const major = majorUnits();
  const fields = opts.withPartner ? ["Partner", ...COMMISSION_FIELDS] : COMMISSION_FIELDS;
  const data = rows.map((r) => (opts.withPartner ? [r.partner ?? "", ...cells(r, major)] : cells(r, major)));
  return { filename: csvFilename(opts.filenamePrefix || "commissions", now), csv: unparse(fields, data), rows: data.length };
}

/**
 * One statement as CSV: its entries (the commission columns), then a blank row, then its total, each
 * tax line (withheld ones negative) and the net payable, in the Commission column.
 */
export function statementCsv(statement: StatementCsvHead, entries: CommissionCsvRow[], now: Date = new Date()): CsvExport {
  refuseOver(entries.length);
  const major = majorUnits();
  const currency = statement.currency.trim().toUpperCase();
  const summary = (label: string, amount: number | bigint, rateBp: number | null = null): (string | number)[] => {
    const row: (string | number)[] = COMMISSION_FIELDS.map(() => "");
    row[0] = label;
    if (rateBp !== null) row[RATE_AT] = ratePercent(rateBp);
    row[COMMISSION_AT] = major(amount, currency);
    row[CURRENCY_AT] = currency;
    return row;
  };
  const taxLines = Array.isArray(statement.taxLines) ? statement.taxLines : [];
  const data = [
    ...entries.map((r) => cells(r, major)),
    COMMISSION_FIELDS.map(() => ""),
    summary("Total", statement.total),
    ...taxLines.map((l) => summary(`${l.label} (${l.kind === "ADD" ? "added" : "withheld"})`, l.kind === "ADD" ? l.amount : -l.amount, l.rateBp)),
    summary("Net payable", statement.netPayable),
  ];
  return { filename: csvFilename(`statement-${statement.number}`, now), csv: unparse(COMMISSION_FIELDS, data), rows: entries.length };
}
