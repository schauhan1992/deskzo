import type { CompanyRelationshipType, TradeDocumentStatus, TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { countryFeatureAvailable } from "@/lib/modules-access";
import { computeDocument, GST_STATE_CODES } from "@/lib/gst-engine";
import { lineHsnRefusal } from "@/lib/platform/hsn-directory";
import { createDraftDocument, stateCodeFromName } from "@/lib/documents/create-draft";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { registeredTreatments, tradeDocumentSchema, type TradeDocumentInput } from "@/lib/validation/trade-document";
import { isVendorRelationshipType } from "@/lib/validation/company";
import { normalizeCompanyName } from "@/lib/company-name";
import { resolveAccounts, writeEntry } from "@/lib/ledger/journal";
import { bookingRate } from "@/lib/ledger/posting";
import { settleInvoice, settledStatus } from "@/lib/receivables";
import { workspaceClock } from "@/lib/time/workspace";
import { readHeadings, type ImportPlan, type PlannedRow } from "./import";
import { findUser } from "./importers/lookups";
import { RowReader, type FieldChange } from "./importers/types";

/**
 * Open documents brought from the system a company used before Deskzo (owner, 18 Oct 2026: "open ones
 * only"): proposals, proformas, vendor POs, and the invoices, bills and credit notes still unsettled on
 * the day it moved — with their own numbers, dates and lines. Paid and closed history stays there.
 *
 *   · **One row a line**, as Zoho Books and most systems export documents; rows sharing a Number are one
 *     document, and its header is read from its first row.
 *   · **Built as the document form builds one** (`createDraftDocument`): the party's location gives the
 *     GSTINs, the place of supply and the tax split, and the shared engine works out the totals. A Total
 *     column, when there is one, must agree to the rupee, or the document is refused with both figures.
 *   · **The number stays** and its series moves past it, as a number typed on the form does. A number
 *     already in Deskzo is skipped when it is this same imported document, refused otherwise — so the same
 *     file again changes nothing.
 *   · **The party must exist** — import Companies or Vendors first. Lines are linked to the catalogue by
 *     SKU or name when they match, and take its HSN, unit and tax rate where the file leaves them blank.
 *   · **Quiet.** Marked IMPORTED and issued as they were there: no approval, no e-invoice, no notification,
 *     no workflow.
 *
 * **Invoices, bills and credit notes** carry money, so three more things (owner: "the import does"):
 *   · Each comes with its **balance due** — blank means all of it — and what was settled before is kept
 *     on the document (`paidBefore`), so receivables, ageing and collections chase only what is left. One
 *     fully settled is refused: it belongs in the old system.
 *   · Its balance is posted on **the day the books start in Deskzo**, which the import asks for, against
 *     the party's receivable or payable with Opening Balance Equity on the other side — never sales or
 *     tax. It is the document's own entry, so cancelling the document reverses it like any other.
 *   · It stays out of sales, GST returns, targets, commission and revenue: what was sold was sold before.
 *
 * A credit note names the invoice it reduces, which must be in Deskzo.
 */

export const DOCUMENT_IMPORT_TYPES = ["PROPOSAL", "PROFORMA", "PURCHASE_ORDER", "INVOICE", "BILL", "CREDIT_NOTE"] as const satisfies readonly TradeDocumentType[];
export type DocumentImportType = (typeof DOCUMENT_IMPORT_TYPES)[number];
export const isDocumentImportType = (value: unknown): value is DocumentImportType => (DOCUMENT_IMPORT_TYPES as readonly unknown[]).includes(value);

/** The types that carry a balance, and so an opening entry and a start day. */
export const OPENING_TYPES: readonly TradeDocumentType[] = ["INVOICE", "BILL", "CREDIT_NOTE"];
export const needsOpeningDate = (type: TradeDocumentType) => OPENING_TYPES.includes(type);

export const DOCUMENT_COLUMNS = {
  number: "Number",
  date: "Date",
  party: "Party",
  status: "Status",
  validUntil: "Valid until",
  due: "Due date",
  balance: "Balance due",
  against: "Against invoice",
  placeOfSupply: "Place of supply",
  gstin: "GSTIN",
  reference: "Reference",
  salesperson: "Salesperson",
  notes: "Notes",
  terms: "Terms",
  item: "Item",
  description: "Description",
  hsn: "HSN/SAC",
  quantity: "Quantity",
  unit: "Unit",
  rate: "Rate",
  discount: "Discount %",
  tax: "Tax %",
  total: "Total",
} as const;
const C = DOCUMENT_COLUMNS;

/** What each type's own export calls its number, date and party (Zoho Books' among them). */
const OWN: Record<DocumentImportType, { number: string[]; date: string[]; party: string[]; against?: string[] }> = {
  PROPOSAL: { number: ["Estimate Number", "Quote Number", "Quotation Number"], date: ["Estimate Date", "Quote Date", "Quotation Date"], party: ["Customer Name", "Customer"] },
  PROFORMA: { number: ["Proforma Number", "Proforma Invoice Number"], date: ["Proforma Date", "Proforma Invoice Date"], party: ["Customer Name", "Customer"] },
  PURCHASE_ORDER: { number: ["Purchase Order Number", "PO Number"], date: ["Purchase Order Date", "PO Date"], party: ["Vendor Name", "Vendor", "Supplier Name", "Supplier"] },
  INVOICE: { number: ["Invoice Number", "Invoice No"], date: ["Invoice Date"], party: ["Customer Name", "Customer"] },
  BILL: { number: ["Bill Number", "Bill No", "Vendor Invoice Number"], date: ["Bill Date"], party: ["Vendor Name", "Vendor", "Supplier Name", "Supplier"] },
  CREDIT_NOTE: {
    number: ["Credit Note Number", "Credit Note No", "CreditNote Number"],
    date: ["Credit Note Date", "CreditNote Date"],
    party: ["Customer Name", "Customer"],
    against: ["Invoice Number", "Associated Invoice Number", "Reference Invoice Number", "Original Invoice Number"],
  },
};

/** The usual headings, matched ignoring case and punctuation. To be tightened against real exports. */
export function aliasesFor(type: DocumentImportType): Record<string, string[]> {
  const own = OWN[type];
  return {
    [C.number]: [...own.number, "Document Number"],
    [C.date]: [...own.date, "Document Date"],
    [C.party]: [...own.party, "Company Name", "Party Name"],
    [C.status]: ["Estimate Status", "Quote Status", "Purchase Order Status", "Invoice Status", "Bill Status", "Credit Note Status", "Document Status"],
    [C.validUntil]: ["Expiry Date", "Valid Till", "Quote Expiry Date", "Estimate Expiry Date"],
    [C.due]: ["Payment Due Date"],
    [C.balance]: ["Balance", "Balance Due", "Amount Due", "Outstanding", "Outstanding Amount", "Credits Remaining", "Balance Credits"],
    ...(own.against ? { [C.against]: own.against } : {}),
    [C.placeOfSupply]: ["Place Of Supply(With State Code)", "Supply State"],
    [C.gstin]: ["GST Identification Number (GSTIN)", "Customer GSTIN", "Vendor GSTIN", "GST Number", "GSTIN/UIN"],
    [C.reference]: ["Reference#", "Reference Number", "Reference No"],
    [C.salesperson]: ["Sales Person", "Salesperson Name"],
    [C.notes]: ["Customer Notes", "Vendor Notes"],
    [C.terms]: ["Terms & Conditions", "Terms and Conditions"],
    [C.item]: ["Item Name", "Product", "Product Name"],
    [C.description]: ["Item Desc", "Item Description", "Line Description"],
    [C.hsn]: ["HSN Code", "SAC Code", "HSN/SAC Code"],
    [C.quantity]: ["Qty"],
    [C.unit]: ["Usage Unit", "UOM", "Unit of Measure"],
    [C.rate]: ["Item Price", "Unit Price", "Price"],
    [C.discount]: ["Discount(%)", "Discount Percent", "Item Discount %"],
    [C.tax]: ["Item Tax %", "Tax Percentage", "GST %", "GST Rate", "Tax Rate"],
    [C.total]: ["Document Total", "Total Amount", "Grand Total", "Estimate Total", "Invoice Total", "Bill Total"],
  };
}

/** The template's columns for a type: the balance and start-day ones only where they mean something. */
export function documentTemplateColumns(type: DocumentImportType): string[] {
  return Object.values(C).filter((c) => (c === C.balance ? needsOpeningDate(type) : c === C.against ? type === "CREDIT_NOTE" : c === C.validUntil ? type === "PROPOSAL" : true));
}
const headingsFor = (type: DocumentImportType) => ({ templateColumns: Object.values(C) as string[], headerAliases: aliasesFor(type) });

type Applied = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };
export type DocumentImportOptions = { openingDate?: string | null };

export type Group = { number: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing a Number, in file order. A row with no Number belongs to the document above it. */
export function groupRows(rows: Record<string, string>[]): Group[] {
  const groups: Group[] = [];
  const byNumber = new Map<string, Group>();
  rows.forEach((row, i) => {
    const line = i + 2;
    const number = (row[C.number] ?? "").trim();
    const group = number ? byNumber.get(number) : groups[groups.length - 1];
    if (group) group.rows.push({ line, row });
    else {
      const made: Group = { number, firstLine: line, rows: [{ line, row }] };
      groups.push(made);
      if (number) byNumber.set(number, made);
    }
  });
  return groups;
}

/** A status word as one of a proposal's, proforma's or PO's. Blank or unknown: issued. */
function statusOf(type: DocumentImportType, text: string): TradeDocumentStatus {
  const t = text.trim().toLowerCase();
  if (/draft/.test(t)) return "DRAFT";
  if (type === "PROPOSAL" && /accept|approved|won/.test(t)) return "ACCEPTED";
  return "ISSUED";
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type Opening = { day: string; at: Date } | null;
export type Ready = {
  input: TradeDocumentInput;
  status: TradeDocumentStatus;
  partyName: string;
  total: number;
  lineCount: number;
  /** For an invoice, bill or credit note: what is still due (or, on a credit note, still to use). */
  balance: number | null;
};
export type Resolved = { error: string; line?: number } | { skip: string } | Ready;

/**
 * A year brought across (src/lib/migration): the first day of the financial year and the day the company
 * switched. Its documents are dated inside it and may be settled already; one made before by the same
 * migration is passed over.
 */
export type HistoryWindow = { from: string; to: string };

/** What a group of rows makes: the form's input for it, or why it can't be made, or that it's already here. */
export async function resolveGroup(type: DocumentImportType, group: Group, clock: Awaited<ReturnType<typeof workspaceClock>>, opening: Opening, history: HistoryWindow | null = null): Promise<Resolved> {
  if (!group.number) return { error: `${C.number} is required — every document keeps the number it had.` };
  const head = new RowReader(group.rows[0]!.row, clock);
  const purchase = documentDirection[type] === "PURCHASE";
  const label = tradeDocumentLabels[type].toLowerCase();

  // A migrated bill is numbered in Deskzo's bill series, the vendor's own number kept as its reference: vendors'
  // numbers clash with each other's and with ours, and a year of bills makes that likely. Its migration knows
  // it by vendor and number (src/lib/migration/purchases.ts).
  const seriesNumbered = history !== null && type === "BILL";
  const taken = seriesNumbered ? null : await db.tradeDocument.findUnique({ where: { docNumber: group.number }, select: { docType: true, origin: true, company: { select: { name: true } } } });
  if (taken) {
    if (taken.docType === type && taken.origin === (history ? "MIGRATED" : "IMPORTED")) return { skip: `${group.number} is already in Deskzo` };
    return { error: `${group.number} is already used by another document in Deskzo (${tradeDocumentLabels[taken.docType].toLowerCase()} for ${taken.company.name}).` };
  }

  const partyName = head.text(C.party);
  if (!partyName) return { error: `${C.party} is required — the ${purchase ? "vendor" : "customer"} the document is for.` };
  const party = await db.company.findUnique({
    where: { normalizedName: normalizeCompanyName(partyName) },
    select: { id: true, name: true, relationshipType: true },
  });
  if (!party) return { error: `No ${purchase ? "vendor" : "company"} named "${partyName}". Import ${purchase ? "Vendors" : "Companies"} first, or correct the spelling.` };
  const vendor = isVendorRelationshipType(party.relationshipType as CompanyRelationshipType);
  if (purchase && !vendor) return { error: `${party.name} isn't a vendor — a ${label} is from a vendor.` };
  if (!purchase && vendor) return { error: `${party.name} is a vendor — a ${label} goes to a customer.` };

  const issueDate = head.date(C.date);
  const validUntil = head.date(C.validUntil);
  const dueDate = head.date(C.due);
  if (head.error) return { error: head.error };
  if (!issueDate) return { error: `${C.date} is required — the day the document was raised.` };
  if (opening && issueDate.toISOString().slice(0, 10) > opening.day) {
    return { error: `It's dated after ${opening.day}, the day your books start in Deskzo — raise it in Deskzo instead.` };
  }
  if (history) {
    const day = issueDate.toISOString().slice(0, 10);
    if (day < history.from || day >= history.to) {
      return { error: `It's dated ${day}, outside the year being brought across (${history.from} to the day before ${history.to}).` };
    }
  }

  // A credit note reduces an invoice, which has to be here for it to name.
  let againstDocumentId = "";
  if (type === "CREDIT_NOTE") {
    const againstNumber = head.text(C.against);
    if (!againstNumber) return { error: `A credit note names the invoice it reduces — give ${C.against}.` };
    const invoice = await db.tradeDocument.findFirst({ where: { docNumber: againstNumber, docType: "INVOICE", companyId: party.id }, select: { id: true } });
    if (!invoice) {
      return { error: `Invoice ${againstNumber} for ${party.name} isn't in Deskzo. Import it first — or, if it was settled in the old system, put this credit in the customer's opening balance instead.` };
    }
    againstDocumentId = invoice.id;
  }

  // The place of supply: a state code or name, else the party's location decides (as on the form).
  const posCell = head.text(C.placeOfSupply);
  let placeOfSupplyCode = "";
  if (posCell) {
    const code = /^\d{2}\b/.exec(posCell)?.[0] ?? null;
    placeOfSupplyCode = code && code in GST_STATE_CODES ? code : (stateCodeFromName(posCell.replace(/^\d{2}\s*[-–]\s*/, "")) ?? "");
    if (!placeOfSupplyCode) return { error: `${C.placeOfSupply} "${posCell}" isn't a state Deskzo knows — use its name or its two-digit GST code.` };
  }

  // The party's GSTIN and treatment: the file's, else its location's — what the form would fill in.
  const location = await db.companyLocation.findFirst({
    where: { companyId: party.id },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { id: true, gstNumber: true, gstTreatment: true, address: true, city: true, state: true, pincode: true, country: true },
  });
  const gstin = (head.text(C.gstin) || location?.gstNumber || "").toUpperCase();
  const registered = registeredTreatments.includes(location?.gstTreatment as (typeof registeredTreatments)[number]);
  const gstTreatment = gstin ? (registered ? location!.gstTreatment : "REGISTERED_REGULAR") : "UNREGISTERED";

  const salespersonCell = head.text(C.salesperson);
  const salesperson = salespersonCell ? await findUser(salespersonCell) : null;

  // ── Lines ──
  const lines: TradeDocumentInput["lines"] = [];
  for (const { line, row } of group.rows) {
    const r = new RowReader(row, clock);
    const name = r.text(C.item);
    if (!name) return { error: `${C.item} is required on every line.`, line };
    const quantity = r.number(C.quantity) ?? 1;
    const rate = r.number(C.rate);
    const discount = r.number(C.discount) ?? 0;
    const taxCell = r.number(C.tax);
    if (r.error) return { error: r.error, line };
    if (rate === undefined) return { error: `${C.rate} is required on every line.`, line };
    if (quantity <= 0) return { error: `${C.quantity} must be more than 0.`, line };
    if (rate < 0 || discount < 0 || discount > 100 || (taxCell !== undefined && (taxCell < 0 || taxCell > 100))) {
      return { error: `${C.rate}, ${C.discount} and ${C.tax} can't be negative, and the percentages are at most 100.`, line };
    }
    const item = await db.item.findFirst({
      where: { OR: [{ sku: { equals: name, mode: "insensitive" } }, { name: { equals: name, mode: "insensitive" } }] },
      select: { id: true, name: true, hsnCode: true, unit: true, taxRatePercent: true },
    });
    lines.push({
      itemId: item?.id ?? "",
      companyProductId: "",
      name: item?.name ?? name,
      description: r.text(C.description),
      hsnCode: r.text(C.hsn) || item?.hsnCode || "",
      unit: r.text(C.unit) || item?.unit || "",
      quantity,
      unitPrice: rate,
      discountMode: "PERCENT",
      discountValue: discount,
      taxRatePercent: taxCell ?? (item?.taxRatePercent ? Number(item.taxRatePercent) : 0),
      servicePeriodFrom: "",
      servicePeriodTo: "",
      billingMilestoneId: "",
    });
  }
  if ((await countryFeatureAvailable("hsn")) && lines.some((l) => l.hsnCode)) {
    const hsnError = await lineHsnRefusal(lines);
    if (hsnError) return { error: hsnError };
  }

  const billing = location
    ? { attention: "", line1: location.address ?? "", line2: "", city: location.city ?? "", state: location.state ?? "", stateCode: stateCodeFromName(location.state) ?? "", pincode: location.pincode ?? "", country: location.country ?? "", phone: "" }
    : {};
  const day = (d: Date | undefined) => (d ? d.toISOString().slice(0, 10) : "");
  const candidate = {
    docType: type,
    companyId: party.id,
    locationId: location?.id ?? "",
    docNumber: seriesNumbered ? "" : group.number,
    placeOfSupplyCode,
    gstTreatment,
    buyerGstin: gstin,
    issueDate: day(issueDate),
    dueDate: day(dueDate),
    validUntil: day(validUntil),
    reference: (seriesNumbered ? [group.number, head.text(C.reference)].filter(Boolean).join(" · ") : head.text(C.reference)).slice(0, 120),
    salespersonId: salesperson?.id ?? "",
    notes: head.text(C.notes),
    terms: head.text(C.terms),
    againstDocumentId,
    billing,
    shippingSameAsBilling: true,
    shipping: {},
    lines,
  };
  let parsed = tradeDocumentSchema.safeParse(candidate);
  // An address on file that the form would refuse (an old pincode) shouldn't refuse the document.
  if (!parsed.success && parsed.error.issues.some((i) => i.path[0] === "billing")) parsed = tradeDocumentSchema.safeParse({ ...candidate, billing: {} });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "This document can't be read." };

  // The tax split doesn't change the total, only how it is labelled; a rupee covers round-off and per-line paise.
  const total = round2(
    computeDocument(
      lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountMode: l.discountMode, discountValue: l.discountValue, taxRatePercent: l.taxRatePercent })),
      "INTER_STATE",
      { roundOff: false },
    ).total,
  );
  const stated = head.number(C.total);
  if (stated !== undefined && Math.abs(stated - total) > 1) {
    return { error: `Its lines come to ${rupees(total)}, but the file's ${C.total} is ${rupees(stated)}. Check the quantities, rates, discounts and tax rates.` };
  }

  // What is still to settle: blank means all of it; nothing left means it stays in the old system.
  let balance: number | null = null;
  if (needsOpeningDate(type) && !history) {
    const cell = head.number(C.balance);
    if (head.error) return { error: head.error };
    balance = cell === undefined ? total : round2(cell);
    if (balance <= 0) return { error: `Nothing is left to settle on it — a ${label} settled in the old system stays there.` };
    if (balance > total + 1) return { error: `Its ${C.balance} (${rupees(balance)}) is more than its total (${rupees(total)}).` };
    balance = Math.min(balance, total);
  }
  return { input: parsed.data, status: statusOf(type, head.text(C.status)), partyName: party.name, total, lineCount: lines.length, balance };
}

/** The start day as typed (yyyy-mm-dd), checked against the books' lock; an error for a type that needs one. */
async function openingOf(type: DocumentImportType, options: DocumentImportOptions): Promise<Opening | { error: string }> {
  if (!needsOpeningDate(type)) return null;
  const day = (options.openingDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: "Give the day your books start in Deskzo — the opening balances are posted on it." };
  const lock = await db.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
  if (lock?.lockedUntil && day <= lock.lockedUntil.toISOString().slice(0, 10)) {
    return { error: `The books are closed to ${lock.lockedUntil.toISOString().slice(0, 10)}. Pick a start day after that.` };
  }
  // Midday UTC, as payroll and depreciation post: the same calendar day wherever the workspace is.
  return { day, at: new Date(`${day}T12:00:00Z`) };
}

/** What the file would bring in, one row per document, writing nothing. */
export async function planDocumentImport(type: DocumentImportType, fileRows: Record<string, string>[], options: DocumentImportOptions = {}): Promise<ImportPlan> {
  const opening = await openingOf(type, options);
  if (opening && "error" in opening) throw new Error(opening.error);
  const { rows, readAs } = readHeadings(headingsFor(type), fileRows);
  const clock = await workspaceClock();
  const planned: PlannedRow[] = [];
  for (const group of groupRows(rows)) {
    const result = await resolveGroup(type, group, clock, opening);
    const label = group.number || `Row ${group.firstLine}`;
    if ("error" in result) {
      planned.push({ line: result.line ?? group.firstLine, action: "error", key: "", label, changes: [], error: result.error });
    } else if ("skip" in result) {
      planned.push({ line: group.firstLine, action: "skip", key: group.number, label, changes: [] });
    } else {
      const before = result.balance === null ? 0 : round2(result.total - result.balance);
      const changes: FieldChange[] = [
        { field: "Party", from: "(new)", to: result.partyName },
        { field: C.date, from: "(new)", to: result.input.issueDate },
        { field: "Lines", from: "(new)", to: String(result.lineCount) },
        { field: C.total, from: "(new)", to: rupees(result.total) },
        ...(result.balance !== null ? [{ field: type === "CREDIT_NOTE" ? "Credit left" : C.balance, from: "(new)", to: rupees(result.balance) }] : []),
        ...(before > 0 ? [{ field: type === "CREDIT_NOTE" ? "Used before Deskzo" : "Paid before Deskzo", from: "(new)", to: rupees(before) }] : []),
        ...(result.status !== "ISSUED" ? [{ field: C.status, from: "(new)", to: result.status.toLowerCase() }] : []),
        ...(result.input.validUntil ? [{ field: C.validUntil, from: "(new)", to: result.input.validUntil }] : []),
        ...(result.input.dueDate ? [{ field: C.due, from: "(new)", to: result.input.dueDate }] : []),
      ];
      planned.push({ line: group.firstLine, action: "create", key: group.number, label: `${group.number} · ${result.partyName}`, changes });
    }
  }
  const creates = planned.filter((r) => r.action === "create");
  const notices =
    opening && creates.length > 0
      ? [
          {
            text: `Their balances are posted to Receivables or Payables on ${opening.day}, against Opening Balance Equity. Leave these customers' and vendors' balances out of the rest of your opening entry.`,
            lines: creates.map((r) => r.line),
          },
        ]
      : [];
  const known = new Set(Object.values(C) as string[]);
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  return {
    area: `documents:${type}`,
    totalRows: planned.length,
    creates: creates.length,
    updates: 0,
    skips: planned.filter((r) => r.action === "skip").length,
    errors: planned.filter((r) => r.action === "error").length,
    rows: planned,
    unknownColumns: [...present].filter((c) => c && !known.has(c)),
    notices,
    readAs,
  };
}

/**
 * An invoice's, bill's or credit note's opening: what was settled before kept on it, its status from what
 * is left, and its balance posted on the start day as its own entry — the party's receivable or payable
 * against Opening Balance Equity, in rupees at the document's rate. Inside the caller's transaction.
 */
async function postOpening(tx: Parameters<typeof writeEntry>[0], documentId: string, type: TradeDocumentType, balance: number, opening: { day: string; at: Date }, userId: string) {
  const doc = await tx.tradeDocument.findUniqueOrThrow({
    where: { id: documentId },
    select: { docNumber: true, total: true, currency: true, exchangeRate: true, companyId: true, branchId: true, gstRegistrationId: true },
  });
  const total = Number(doc.total);
  const paidBefore = Math.max(0, round2(total - balance));
  const status = type === "CREDIT_NOTE" ? "ISSUED" : settledStatus(settleInvoice(total, paidBefore, 0));
  await tx.tradeDocument.update({ where: { id: documentId }, data: { paidBefore, status } });

  const accounts = await resolveAccounts(tx, ["AR", "AP", "OPENING_BALANCE_EQUITY"]);
  // At the rate every other reading of the document uses (the close's tie-out among them): 1 for rupees.
  const amount = round2(Math.min(balance, total) * bookingRate(doc));
  const equity = accounts.get("OPENING_BALANCE_EQUITY")!;
  const party = type === "BILL" ? accounts.get("AP")! : accounts.get("AR")!;
  // An invoice is owed to us; a bill we owe; a credit note's credit is ours to give back.
  const owedToUs = type === "INVOICE";
  await writeEntry(tx, {
    date: opening.at,
    narration: `Opening balance — ${tradeDocumentLabels[type].toLowerCase()} ${doc.docNumber}, brought from the old system`,
    source: type as "INVOICE" | "BILL" | "CREDIT_NOTE",
    userId,
    documentId,
    companyId: doc.companyId,
    branchId: doc.branchId,
    gstRegistrationId: doc.gstRegistrationId,
    lines: owedToUs
      ? [
          { accountId: party, debit: amount, credit: 0, companyId: doc.companyId },
          { accountId: equity, debit: 0, credit: amount },
        ]
      : [
          { accountId: equity, debit: amount, credit: 0 },
          { accountId: party, debit: 0, credit: amount, companyId: doc.companyId },
        ],
  });
}

/**
 * Brings the documents in, one at a time: a document that can't be made is named and the rest still
 * land, as every import does. Each is created as the form creates one, then marked as it was there; an
 * invoice, bill or credit note with its opening entry in the same step, or not at all.
 */
export async function applyDocumentImport(type: DocumentImportType, fileRows: Record<string, string>[], actorUserId: string, options: DocumentImportOptions = {}): Promise<Applied> {
  const opening = await openingOf(type, options);
  if (opening && "error" in opening) throw new Error(opening.error);
  const { rows } = readHeadings(headingsFor(type), fileRows);
  const clock = await workspaceClock();
  const result: Applied = { created: 0, updated: 0, skipped: 0, failed: [] };
  for (const group of groupRows(rows)) {
    const resolved = await resolveGroup(type, group, clock, opening);
    if ("error" in resolved) {
      result.failed.push({ line: resolved.line ?? group.firstLine, error: resolved.error });
      continue;
    }
    if ("skip" in resolved) {
      result.skipped += 1;
      continue;
    }
    // A document whose opening couldn't be posted goes again, rather than staying with no balance in the books.
    let unposted: string | null = null;
    try {
      const made = await createDraftDocument({ id: actorUserId }, resolved.input, "IMPORTED");
      if (!made.ok) {
        result.failed.push({ line: group.firstLine, error: made.error });
        continue;
      }
      const id = made.data.id;
      // Issued as it was there, on the day it was raised — and nothing that issuing sets off.
      const issued = { issuedAt: new Date(`${resolved.input.issueDate}T00:00:00Z`), einvoiceStatus: "NOT_APPLICABLE" as const };
      if (opening && resolved.balance !== null) {
        const balance = resolved.balance;
        unposted = id;
        await db.$transaction(async (tx) => {
          await tx.tradeDocument.update({ where: { id }, data: { ...issued, status: "ISSUED" } });
          await postOpening(tx, id, type, balance, opening, actorUserId);
        });
        unposted = null;
      } else if (resolved.status !== "DRAFT") {
        await db.tradeDocument.update({ where: { id }, data: { ...issued, status: resolved.status } });
      }
      await recordAudit({
        userId: actorUserId,
        action: "CREATE",
        entityType: "TradeDocument",
        entityId: id,
        entityLabel: `${tradeDocumentLabels[type]} ${group.number} for ${resolved.partyName} (imported)`,
      });
      result.created += 1;
    } catch (err) {
      if (unposted) await db.tradeDocument.delete({ where: { id: unposted } }).catch(() => {});
      result.failed.push({ line: group.firstLine, error: err instanceof Error ? err.message : "Failed to write." });
    }
  }
  return result;
}
