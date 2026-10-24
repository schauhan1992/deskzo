import { Prisma, type CompanyRelationshipType } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { createDraftDocument } from "@/lib/documents/create-draft";
import { computeDocument } from "@/lib/gst-engine";
import { writeEntry } from "@/lib/ledger/journal";
import { DOCUMENT_COLUMNS, aliasesFor, resolveGroup, type Group } from "@/lib/portability/documents";
import { RowReader } from "@/lib/portability/importers/types";
import { isVendorRelationshipType } from "@/lib/validation/company";
import type { TradeDocumentInput } from "@/lib/validation/trade-document";
import { leftBehind, refreshSettledStatus, settlementOf, type UnitOutcome } from "./documents";
import { findParty, splitInputTax, stateCodeOf, vendorStateCode, type LedgerContext, type StepContext } from "./ledger";
import { billKey } from "./receipts";
import { asDate } from "./state";

/**
 * A migrated year's purchases (src/lib/migration): the vendors' bills and the credits they gave.
 *
 * **Bills** are read as the open-documents import reads a document — one row a line, the vendor by name, the
 * lines by item, the tax split by where the vendor is (src/lib/portability/documents.ts) — with what a year of
 * purchases needs besides:
 *
 *   · **Numbered in Deskzo's bill series**, the vendor's own number kept as the reference and as how the
 *     migration knows it: vendors' numbers clash with each other's. A payment or a credit names a bill by the
 *     vendor's number, as the old system shows it.
 *   · **Each line to its own account** — the Account the old system posted it to (Rent, Office Supplies,
 *     Furniture), by code or name, Purchases when the file leaves it blank — with the input tax, Payables and
 *     any TDS as a bill posts them. Deskzo's own bill form posts every line to Purchases; a migrated bill
 *     doesn't, or the month-end check would disagree on those accounts every month.
 *   · **TDS** at the rate the file gives (or worked out from its amount), with its section.
 *
 * **Vendor credits** (Zoho Books' name; a debit note to some) become Deskzo's vendor credits — a credit note
 * from the vendor — with the same per-line accounts (Purchase Rebates & Discounts when blank), the input tax
 * they reverse, and set against the bills they name.
 *
 * Void and draft ones stay behind. Posted on their own dates, quietly: no stock, no approval, no notification.
 */

const C = DOCUMENT_COLUMNS;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// ── Bills ──

export const BILL_COLUMNS = { accountCode: "Account code", account: "Account", tdsRate: "TDS %", tdsSection: "TDS section", tdsAmount: "TDS amount" } as const;
const P = BILL_COLUMNS;

const BILL_ALIASES: Record<string, string[]> = {
  [P.accountCode]: ["Account Code", "GL Code", "Ledger Code"],
  [P.account]: ["Account Name", "Expense Account", "Purchase Account", "Item Account", "Ledger"],
  [P.tdsRate]: ["TDS Percentage", "TDS Rate", "TDS Rate %", "TDS(%)", "TDS Percent"],
  [P.tdsSection]: ["TDS Section", "TDS Name", "TDS Tax Name", "Section"],
  [P.tdsAmount]: ["TDS Amount", "TDS"],
};

export const billHeadings = { templateColumns: [...Object.values(C), ...Object.values(P)] as string[], headerAliases: { ...aliasesFor("BILL"), ...BILL_ALIASES } };

export function billColumns(): string[] {
  const own = Object.values(C).filter((c) => c !== C.balance && c !== C.validUntil && c !== C.against && c !== C.salesperson);
  return [...own, P.accountCode, P.account, P.tdsRate, P.tdsSection, P.tdsAmount];
}

/**
 * Rows that are one document: sharing a number and a party, in file order. A row with no number belongs to the
 * one above; a row with the number and no party, to the last with that number — as exports leave the header
 * blank on a document's later lines.
 */
function groupByPartyAndNumber(rows: Record<string, string>[], numberColumn: string, partyColumn: string): Group[] {
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const lastByNumber = new Map<string, Group>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const number = (row[numberColumn] ?? "").trim();
    const party = (row[partyColumn] ?? "").trim();
    const key = `${normalizeCompanyName(party)}|${number}`;
    const group = !number ? groups[groups.length - 1] : party ? byKey.get(key) : lastByNumber.get(number);
    if (group) return void group.rows.push({ line, row });
    const made: Group = { number, firstLine: line, rows: [{ line, row }] };
    groups.push(made);
    if (number) {
      byKey.set(key, made);
      lastByNumber.set(number, made);
    }
  });
  return groups;
}

export const billUnits = (rows: Record<string, string>[]) => groupByPartyAndNumber(rows, C.number, C.party);

/** A line with no item is named for what it was — its description, else its account — and the file's total is checked here, TDS and all. */
function prepared(group: Group): Group {
  return {
    ...group,
    rows: group.rows.map(({ line, row }) => ({
      line,
      row: { ...row, [C.item]: (row[C.item] ?? "").trim() || (row[C.description] ?? "").trim() || (row[P.account] ?? "").trim() || "Purchase", [C.total]: "" },
    })),
  };
}

/** A line's account: the one the file names, else the default; never money or a party's account, which a line isn't. */
function lineAccount(ledger: LedgerContext, row: Record<string, string>, codeColumn: string, nameColumn: string, fallback: "PURCHASES" | "PURCHASE_REBATES") {
  const text = (row[codeColumn] ?? "").trim() || (row[nameColumn] ?? "").trim();
  const account = text ? ledger.chart.find(text) : ledger.chart.system(fallback);
  if ("error" in account) return account;
  if (account.isMoney || account.needsParty) return { error: `${account.name} is a ${account.isMoney ? "bank or cash" : "receivable or payable"} account — a line is what was bought or given back.` };
  return account;
}

type BillReady = {
  input: TradeDocumentInput;
  vendorName: string;
  key: string;
  accounts: string[];
  accountNames: string[];
  total: number;
  tds: number;
  lineCount: number;
};

async function resolveBill(group: Group, ctx: StepContext): Promise<{ error: string; line?: number } | { skip: string } | BillReady> {
  const head = new RowReader(group.rows[0]!.row, ctx.clock);
  const behind = leftBehind(head.text(C.status));
  if (behind) return { skip: behind };
  if (!group.number) return { error: `${C.number} is required — the vendor's own number for the bill.` };
  const vendor = head.text(C.party) ? await findParty(head.text(C.party)) : null;
  if (vendor) {
    const done = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "document", key: billKey(vendor.name, group.number) } }, select: { id: true } });
    if (done) return { skip: "already brought across" };
  }

  const ledger = await ctx.ledger();
  const accounts: string[] = [];
  for (const { line, row } of group.rows) {
    const account = lineAccount(ledger, row, P.accountCode, P.account, "PURCHASES");
    if ("error" in account) return { error: account.error, line };
    accounts.push(account.id);
  }
  const tdsRate = head.number(P.tdsRate);
  const tdsAmount = head.number(P.tdsAmount);
  const stated = head.number(C.total);
  if (head.error) return { error: head.error };

  const resolved = await resolveGroup("BILL", prepared(group), ctx.clock, null, ctx.window);
  if ("error" in resolved) return resolved;
  if ("skip" in resolved) return { skip: "already brought across" };

  // TDS at the file's rate, else the rate its amount works out to; the total either side of it.
  const lines = resolved.input.lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountMode: l.discountMode, discountValue: l.discountValue, taxRatePercent: l.taxRatePercent }));
  const at = (rate: number) => computeDocument(lines, "INTER_STATE", { withholdingMode: rate > 0 ? "TDS" : "NONE", withholdingRatePercent: rate, roundOff: false });
  let rate = tdsRate ?? 0;
  if (!rate && tdsAmount && tdsAmount > 0) {
    const base = at(0).taxableValue;
    rate = base > 0 ? round2((tdsAmount / base) * 100) : 0;
  }
  if (rate < 0 || rate > 100) return { error: `${P.tdsRate} is a percentage, 0 to 100.` };
  const computed = at(rate);
  const tds = Math.abs(computed.withholdingAmount);
  if (tdsAmount !== undefined && Math.abs(tdsAmount - tds) > 1) {
    return { error: `Its TDS comes to ${rupees(tds)} at ${rate}%, but the file's ${P.tdsAmount} is ${rupees(tdsAmount)}. Give the ${P.tdsRate}.` };
  }
  if (stated !== undefined && Math.abs(stated - computed.total) > 1 && Math.abs(stated - (computed.total + tds)) > 1) {
    return { error: `Its lines come to ${rupees(round2(computed.total + tds))}${tds ? ` (${rupees(computed.total)} after TDS)` : ""}, but the file's ${C.total} is ${rupees(stated)}. Check the quantities, rates, discounts and tax rates.` };
  }
  const section = head.text(P.tdsSection).slice(0, 20);
  return {
    input: { ...resolved.input, withholdingMode: rate > 0 ? "TDS" : "NONE", withholdingRatePercent: rate, withholdingSection: rate > 0 ? section : "" },
    vendorName: resolved.partyName,
    key: billKey(resolved.partyName, group.number),
    accounts,
    accountNames: [...new Set(accounts.map((id) => ledger.chart.byId.get(id)!.name))],
    total: computed.total,
    tds,
    lineCount: resolved.lineCount,
  };
}

export async function checkBill(group: Group, ctx: StepContext): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveBill(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const accounts = r.accountNames.length > 3 ? `${r.accountNames.slice(0, 3).join(", ")} and ${r.accountNames.length - 3} more` : r.accountNames.join(", ");
  return {
    kind: "create",
    label: `${group.number} · ${r.vendorName}`,
    detail: `${r.input.issueDate} · ${r.lineCount} line${r.lineCount === 1 ? "" : "s"} · ${rupees(r.total)}${r.tds ? ` after TDS ${rupees(r.tds)}` : ""} · to ${accounts}`,
  };
}

/** Brings one bill across: made, issued and posted on its own date line by line to its accounts, recorded against the migration. */
export async function applyBill(group: Group, ctx: StepContext): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveBill(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const ledger = await ctx.ledger();
  const made = await createDraftDocument({ id: ctx.userId }, r.input, "MIGRATED");
  if (!made.ok) return { kind: "error", label, line: group.firstLine, error: made.error };
  const id = made.data.id;
  let docNumber = "";
  try {
    await db.$transaction(async (tx) => {
      const issueDate = asDate(r.input.issueDate);
      await tx.tradeDocument.update({ where: { id }, data: { status: "ISSUED", issuedAt: issueDate } });
      const doc = await tx.tradeDocument.findUniqueOrThrow({
        where: { id },
        select: {
          docNumber: true, companyId: true, issueDate: true, branchId: true, gstRegistrationId: true,
          taxableValue: true, cgstAmount: true, sgstAmount: true, igstAmount: true, shippingCharge: true,
          withholdingAmount: true, adjustment: true, roundOff: true, total: true,
          lines: { orderBy: { sortOrder: "asc" }, select: { taxableValue: true } },
        },
      });
      docNumber = doc.docNumber;
      const entry = await writeEntry(tx, {
        date: doc.issueDate,
        narration: `Vendor bill ${doc.docNumber} — ${r.vendorName}'s ${group.number}`,
        source: "BILL",
        userId: ctx.userId,
        lines: billEntryLines(doc, r.accounts, ledger),
        documentId: id,
        companyId: doc.companyId,
        branchId: doc.branchId ?? ledger.head.branchId,
        gstRegistrationId: doc.gstRegistrationId ?? ledger.head.gstRegistrationId,
      });
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "document", recordId: id, key: r.key } });
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `${r.key}:entry` } });
    });
  } catch (err) {
    // Not half there: the draft goes with the posting that failed.
    await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    return { kind: "error", label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${group.number} · ${r.vendorName}`, detail: `Bill ${docNumber}` };
}

type BillFigures = {
  companyId: string;
  taxableValue: Prisma.Decimal;
  cgstAmount: Prisma.Decimal;
  sgstAmount: Prisma.Decimal;
  igstAmount: Prisma.Decimal;
  shippingCharge: Prisma.Decimal;
  withholdingAmount: Prisma.Decimal;
  adjustment: Prisma.Decimal;
  roundOff: Prisma.Decimal;
  total: Prisma.Decimal;
  lines: { taxableValue: Prisma.Decimal }[];
};

/**
 * A migrated bill's entry: what a bill posts (src/lib/ledger/posting.ts `postVendorBill`), with each line's
 * cost on its own account instead of all of it on Purchases. The paise the lines' rounding leaves go to the
 * largest of them, so the entry is the bill's to the paisa.
 */
export function billEntryLines(doc: BillFigures, accounts: string[], ledger: LedgerContext) {
  const n = (d: Prisma.Decimal) => Number(d);
  const purchases = ledger.chart.system("PURCHASES").id;
  const cost = new Map<string, number>();
  doc.lines.forEach((l, i) => {
    const account = accounts[i] ?? purchases;
    cost.set(account, round2((cost.get(account) ?? 0) + n(l.taxableValue)));
  });
  const spread = round2(n(doc.taxableValue) - n(doc.shippingCharge) - [...cost.values()].reduce((t, v) => t + v, 0));
  if (spread !== 0) {
    const largest = [...cost.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? purchases;
    cost.set(largest, round2((cost.get(largest) ?? 0) + spread));
  }
  const tds = n(doc.withholdingAmount) < 0 ? Math.abs(n(doc.withholdingAmount)) : 0;
  const tcs = n(doc.withholdingAmount) > 0 ? n(doc.withholdingAmount) : 0;
  const signed = (accountId: string, amount: number, narration: string) => (amount > 0 ? { accountId, debit: amount, credit: 0, narration } : { accountId, debit: 0, credit: -amount, narration });
  const lines = [
    ...[...cost.entries()].map(([accountId, amount]) => ({ accountId, debit: amount, credit: 0, narration: null as string | null })),
    { accountId: purchases, debit: n(doc.shippingCharge), credit: 0, narration: "Freight inward" },
    { accountId: ledger.chart.system("INPUT_CGST").id, debit: n(doc.cgstAmount), credit: 0, narration: null },
    { accountId: ledger.chart.system("INPUT_SGST").id, debit: n(doc.sgstAmount), credit: 0, narration: null },
    { accountId: ledger.chart.system("INPUT_IGST").id, debit: n(doc.igstAmount), credit: 0, narration: null },
    { accountId: ledger.chart.system("TDS_RECEIVABLE").id, debit: tcs, credit: 0, narration: "TCS charged by vendor" },
    signed(ledger.chart.system("ADJUSTMENTS").id, n(doc.adjustment), "Adjustment"),
    signed(ledger.chart.system("ROUND_OFF").id, n(doc.roundOff), "Round off"),
    { accountId: ledger.chart.system("AP").id, debit: 0, credit: n(doc.total), narration: null, companyId: doc.companyId },
    { accountId: ledger.chart.system("TDS_PAYABLE").id, debit: 0, credit: tds, narration: "TDS withheld from vendor" },
  ];
  return lines.filter((l) => l.debit > 0 || l.credit > 0);
}

// ── Vendor credits ──

export const VENDOR_CREDIT_COLUMNS = {
  number: "Credit number",
  date: "Date",
  party: "Vendor",
  status: "Status",
  accountCode: "Account code",
  account: "Account",
  description: "Description",
  quantity: "Quantity",
  rate: "Rate",
  amount: "Amount",
  tax: "Tax %",
  supply: "Source of supply",
  bill: "Bill",
  applied: "Amount applied",
  total: "Total",
  notes: "Notes",
} as const;
const V = VENDOR_CREDIT_COLUMNS;

const CREDIT_ALIASES: Record<string, string[]> = {
  [V.number]: ["Vendor Credit Number", "Vendor Credit#", "Vendor Credit No", "Credit Note Number", "Credit Note#", "Debit Note Number", "Debit Note#"],
  [V.date]: ["Vendor Credit Date", "Credit Note Date", "Debit Note Date"],
  [V.party]: ["Vendor Name", "Supplier Name", "Supplier"],
  [V.status]: ["Vendor Credit Status", "Credit Note Status", "Debit Note Status"],
  [V.accountCode]: ["Account Code", "GL Code"],
  [V.account]: ["Account Name", "Expense Account", "Purchase Account"],
  [V.description]: ["Item Name", "Item Desc", "Item Description", "Line Description"],
  [V.quantity]: ["Qty"],
  [V.rate]: ["Item Price", "Unit Price", "Price"],
  [V.amount]: ["Item Total", "Line Amount", "Taxable Amount", "Item Amount"],
  [V.tax]: ["Item Tax %", "Tax Percentage", "GST %", "GST Rate", "Tax Rate"],
  [V.supply]: ["Source Of Supply", "Place of Supply", "Vendor State"],
  [V.bill]: ["Bill Number", "Bill#", "Applied Bill Number", "Bill No"],
  [V.applied]: ["Amount Applied", "Credits Applied", "Applied Amount", "Amount Applied to Bill"],
  [V.total]: ["Total Amount", "Vendor Credit Total", "Credit Total", "Grand Total"],
  [V.notes]: ["Vendor Notes", "Remarks", "Reason"],
};

export const vendorCreditHeadings = { templateColumns: Object.values(V) as string[], headerAliases: CREDIT_ALIASES };
export const vendorCreditColumns = (): string[] => Object.values(V);
export const vendorCreditUnits = (rows: Record<string, string>[]) => groupByPartyAndNumber(rows, V.number, V.party);
const creditKey = (vendorName: string, number: string) => `VCREDIT:${normalizeCompanyName(vendorName)}:${number.trim()}`;

type CreditReady = {
  vendorId: string;
  vendorName: string;
  key: string;
  day: string;
  lines: { accountId: string; amount: number; narration: string | null }[];
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  notes: string | null;
  applications: { billId: string; number: string; amount: number }[];
};

async function resolveCredit(group: Group, ctx: StepContext): Promise<{ error: string; line?: number } | { skip: string } | CreditReady> {
  const head = new RowReader(group.rows[0]!.row, ctx.clock);
  const behind = leftBehind(head.text(V.status));
  if (behind) return { skip: behind };
  if (!group.number) return { error: `${V.number} is required — each credit keeps the number it had.` };
  const vendorName = head.text(V.party);
  if (!vendorName) return { error: `${V.party} is required.` };
  const vendor = await findParty(vendorName);
  if (!vendor) return { error: `No vendor named "${vendorName}". Import Vendors first, or correct the spelling.` };
  if (!isVendorRelationshipType(vendor.relationshipType as CompanyRelationshipType)) return { error: `${vendor.name} isn't a vendor — a vendor credit is from one.` };
  const key = creditKey(vendor.name, group.number);
  const done = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "vendor-credit", key } }, select: { id: true } });
  if (done) return { skip: "already brought across" };
  if (await db.vendorCredit.findUnique({ where: { vendorId_reference: { vendorId: vendor.id, reference: group.number } }, select: { id: true } })) {
    return { error: `${vendor.name}'s ${group.number} is already in Deskzo as a vendor credit.` };
  }
  const date = head.date(V.date);
  const stated = head.number(V.total);
  if (head.error) return { error: head.error };
  if (!date) return { error: `${V.date} is required — the day the vendor gave it.` };
  const day = date.toISOString().slice(0, 10);
  if (day < ctx.window.from || day >= ctx.window.to) return { error: `It's dated ${day}, outside the year being brought across (${ctx.window.from} to the day before ${ctx.window.to}).` };

  const ledger = await ctx.ledger();
  const lines: CreditReady["lines"] = [];
  let tax = 0;
  for (const { line, row } of group.rows) {
    const r = new RowReader(row, ctx.clock);
    const quantity = r.number(V.quantity);
    const rate = r.number(V.rate);
    const given = r.number(V.amount);
    const taxRate = r.number(V.tax) ?? 0;
    if (r.error) return { error: r.error, line };
    const amount = given ?? (rate !== undefined ? round2((quantity ?? 1) * rate) : undefined);
    if (amount === undefined) {
      if (row === group.rows[0]!.row) return { error: `${V.amount} is required — what the line comes to before tax.`, line };
      continue;
    }
    if (amount < 0 || taxRate < 0 || taxRate > 100) return { error: `${V.amount} can't be negative, and ${V.tax} is 0 to 100.`, line };
    const account = lineAccount(ledger, row, V.accountCode, V.account, "PURCHASE_REBATES");
    if ("error" in account) return { error: account.error, line };
    lines.push({ accountId: account.id, amount: round2(amount), narration: r.text(V.description).slice(0, 200) || null });
    tax = round2(tax + round2((amount * taxRate) / 100));
  }
  const taxable = round2(lines.reduce((t, l) => t + l.amount, 0));
  if (taxable <= 0) return { error: "It comes to nothing — give each line's amount." };
  const supply = head.text(V.supply);
  const vendorState = supply ? stateCodeOf(supply) : await vendorStateCode(vendor.id);
  if (supply && !vendorState) return { error: `${V.supply} "${supply}" isn't a state Deskzo knows — use its name or its two-digit GST code.` };
  const split = splitInputTax(tax, vendorState, ledger.head);
  const total = round2(taxable + split.cgst + split.sgst + split.igst);
  if (stated !== undefined && Math.abs(stated - total) > 1) return { error: `Its lines come to ${rupees(total)}, but the file's ${V.total} is ${rupees(stated)}. Check the amounts and tax rates.` };

  // The bills it was set against, each once, by the vendor's number for them.
  const applications: CreditReady["applications"] = [];
  const named = new Map<string, { line: number; applied: number | undefined }>();
  for (const { line, row } of group.rows) {
    const r = new RowReader(row, ctx.clock);
    const bill = r.text(V.bill);
    const applied = r.number(V.applied);
    if (r.error) return { error: r.error, line };
    if (bill && !named.has(bill)) named.set(bill, { line, applied });
  }
  for (const [number, { line, applied }] of named) {
    const record = await db.migrationRecord.findUnique({ where: { migrationId_kind_key: { migrationId: ctx.migrationId, kind: "document", key: billKey(vendor.name, number) } }, select: { recordId: true } });
    const bill = await db.tradeDocument.findFirst({ where: { ...(record ? { id: record.recordId } : { docNumber: number }), docType: "BILL", companyId: vendor.id, status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { id: true } });
    if (!bill) return { error: `Bill ${number} from ${vendor.name} isn't in Deskzo. Bring the bills across first.`, line };
    const owed = (await settlementOf(db, bill.id))?.settlement.balance ?? 0;
    const left = round2(total - applications.reduce((t, a) => t + a.amount, 0));
    const amount = applied ?? (named.size === 1 ? Math.min(left, owed) : undefined);
    if (amount === undefined) return { error: `It's set against ${named.size} bills — give ${V.applied} on each.`, line };
    if (amount < 0) return { error: `${V.applied} can't be negative.`, line };
    if (amount > owed + 1) return { error: `${rupees(amount)} is more than bill ${number} still owed (${rupees(owed)}).`, line };
    if (amount > left + 0.01) return { error: `It sets ${rupees(amount)} against bill ${number}, more than is left of it (${rupees(left)}).`, line };
    if (amount > 0) applications.push({ billId: bill.id, number, amount: round2(Math.min(amount, owed, left)) });
  }

  return {
    vendorId: vendor.id,
    vendorName: vendor.name,
    key,
    day,
    lines,
    taxable,
    ...split,
    total,
    notes: head.text(V.notes).slice(0, 1000) || null,
    applications,
  };
}

export async function checkVendorCredit(group: Group, ctx: StepContext): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveCredit(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  return {
    kind: "create",
    label: `${group.number} · ${r.vendorName}`,
    detail: `${r.day} · ${rupees(r.total)}${r.applications.length ? ` against ${r.applications.map((a) => a.number).join(", ")}` : ""}`,
  };
}

/** Brings one vendor credit across: recorded, posted to its lines' accounts on its own date, set against its bills. */
export async function applyVendorCredit(group: Group, ctx: StepContext): Promise<UnitOutcome> {
  const label = group.number || `Row ${group.firstLine}`;
  const r = await resolveCredit(group, ctx);
  if ("error" in r) return { kind: "error", label, line: r.line ?? group.firstLine, error: r.error };
  if ("skip" in r) return { kind: "skip", label, why: r.skip };
  const ledger = await ctx.ledger();
  const { chart, head } = ledger;
  try {
    await db.$transaction(async (tx) => {
      const date = asDate(r.day);
      const credit = await tx.vendorCredit.create({
        data: {
          vendorId: r.vendorId,
          form: "CREDIT_NOTE",
          kind: "OTHER",
          reference: group.number,
          date,
          taxableAmount: new Prisma.Decimal(r.taxable),
          cgstAmount: new Prisma.Decimal(r.cgst),
          sgstAmount: new Prisma.Decimal(r.sgst),
          igstAmount: new Prisma.Decimal(r.igst),
          total: new Prisma.Decimal(r.total),
          notes: r.notes,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      const byAccount = new Map<string, number>();
      for (const l of r.lines) byAccount.set(l.accountId, round2((byAccount.get(l.accountId) ?? 0) + l.amount));
      const lines = [
        { accountId: chart.system("AP").id, debit: r.total, credit: 0, companyId: r.vendorId, narration: null as string | null },
        ...[...byAccount.entries()].map(([accountId, amount]) => ({ accountId, debit: 0, credit: amount, companyId: null, narration: null })),
        { accountId: chart.system("INPUT_CGST").id, debit: 0, credit: r.cgst, companyId: null, narration: "Input tax reversed" },
        { accountId: chart.system("INPUT_SGST").id, debit: 0, credit: r.sgst, companyId: null, narration: "Input tax reversed" },
        { accountId: chart.system("INPUT_IGST").id, debit: 0, credit: r.igst, companyId: null, narration: "Input tax reversed" },
      ].filter((l) => l.debit > 0 || l.credit > 0);
      const entry = await writeEntry(tx, {
        date,
        narration: `Credit note from ${r.vendorName} (${group.number})`,
        source: "VENDOR_CREDIT",
        userId: ctx.userId,
        lines,
        vendorCreditId: credit.id,
        companyId: r.vendorId,
        branchId: head.branchId,
        gstRegistrationId: head.gstRegistrationId,
      });
      // Dated the credit's own day, as the month-end tie-out and ageing read an application.
      for (const a of r.applications) {
        await tx.vendorCreditApplication.create({ data: { vendorCreditId: credit.id, billId: a.billId, amount: new Prisma.Decimal(a.amount), createdById: ctx.userId, createdAt: date } });
        await refreshSettledStatus(tx, a.billId);
      }
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "vendor-credit", recordId: credit.id, key: r.key } });
      await tx.migrationRecord.create({ data: { migrationId: ctx.migrationId, kind: "journal", recordId: entry.id, key: `${r.key}:entry` } });
    });
  } catch (err) {
    return { kind: "error", label, line: group.firstLine, error: err instanceof Error ? err.message : "It couldn't be posted." };
  }
  return { kind: "create", label: `${group.number} · ${r.vendorName}`, detail: rupees(r.total) };
}
