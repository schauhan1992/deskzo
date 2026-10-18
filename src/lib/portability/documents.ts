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
import { workspaceClock } from "@/lib/time/workspace";
import { readHeadings, type ImportPlan, type PlannedRow } from "./import";
import { findUser } from "./importers/lookups";
import { RowReader, type FieldChange } from "./importers/types";

/**
 * Open documents brought from the system a company used before Deskzo (owner, 18 Oct 2026: "open ones
 * only"): proposals, proformas and vendor POs still in play on the day it moved, with their own numbers,
 * dates and lines. Paid and closed history stays in the old system.
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
 *     no workflow. None of these types posts to the ledger.
 *
 * Invoices, bills and credit notes are the second step: they need their balances in the opening entry.
 */

export const DOCUMENT_IMPORT_TYPES = ["PROPOSAL", "PROFORMA", "PURCHASE_ORDER"] as const satisfies readonly TradeDocumentType[];
export type DocumentImportType = (typeof DOCUMENT_IMPORT_TYPES)[number];
export const isDocumentImportType = (value: unknown): value is DocumentImportType => (DOCUMENT_IMPORT_TYPES as readonly unknown[]).includes(value);

const C = {
  number: "Number",
  date: "Date",
  party: "Party",
  status: "Status",
  validUntil: "Valid until",
  due: "Due date",
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

/**
 * The usual headings in document exports (Zoho Books' estimates, purchase orders and invoices among
 * them), matched ignoring case and punctuation. To be tightened against real exports.
 */
const ALIASES: Record<string, string[]> = {
  [C.number]: ["Estimate Number", "Quote Number", "Quotation Number", "Proforma Number", "Purchase Order Number", "PO Number", "Document Number"],
  [C.date]: ["Estimate Date", "Quote Date", "Quotation Date", "Proforma Date", "Purchase Order Date", "PO Date", "Document Date"],
  [C.party]: ["Customer Name", "Vendor Name", "Customer", "Vendor", "Company Name", "Party Name", "Supplier Name", "Supplier"],
  [C.status]: ["Estimate Status", "Quote Status", "Purchase Order Status", "Document Status"],
  [C.validUntil]: ["Expiry Date", "Valid Till", "Quote Expiry Date", "Estimate Expiry Date"],
  [C.due]: ["Payment Due Date"],
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
  [C.total]: ["Document Total", "Total Amount", "Grand Total", "Estimate Total"],
};

export const DOCUMENT_TEMPLATE_COLUMNS: string[] = Object.values(C);
const headings = { templateColumns: DOCUMENT_TEMPLATE_COLUMNS, headerAliases: ALIASES };

type Applied = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };

type Group = { number: string; firstLine: number; rows: { line: number; row: Record<string, string> }[] };

/** Rows sharing a Number, in file order. A row with no Number belongs to the document above it. */
function groupRows(rows: Record<string, string>[]): Group[] {
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

/** A status word as one of a document's, for the types this import takes. Blank or unknown: issued. */
function statusOf(type: DocumentImportType, text: string): TradeDocumentStatus {
  const t = text.trim().toLowerCase();
  if (/draft/.test(t)) return "DRAFT";
  if (type === "PROPOSAL" && /accept|approved|won/.test(t)) return "ACCEPTED";
  return "ISSUED";
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type Resolved =
  | { error: string; line?: number }
  | { skip: string }
  | { input: TradeDocumentInput; status: TradeDocumentStatus; partyName: string; total: number; lineCount: number };

/** What a group of rows makes: the form's input for it, or why it can't be made, or that it's already here. */
async function resolveGroup(type: DocumentImportType, group: Group, clock: Awaited<ReturnType<typeof workspaceClock>>): Promise<Resolved> {
  if (!group.number) return { error: `${C.number} is required — every document keeps the number it had.` };
  const head = new RowReader(group.rows[0]!.row, clock);
  const purchase = documentDirection[type] === "PURCHASE";

  const taken = await db.tradeDocument.findUnique({ where: { docNumber: group.number }, select: { docType: true, origin: true, company: { select: { name: true } } } });
  if (taken) {
    if (taken.docType === type && taken.origin === "IMPORTED") return { skip: `${group.number} is already in Deskzo` };
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
  if (purchase && !vendor) return { error: `${party.name} isn't a vendor — a purchase order goes to a vendor.` };
  if (!purchase && vendor) return { error: `${party.name} is a vendor — a ${tradeDocumentLabels[type].toLowerCase()} goes to a customer.` };

  const issueDate = head.date(C.date);
  const validUntil = head.date(C.validUntil);
  const dueDate = head.date(C.due);
  if (head.error) return { error: head.error };
  if (!issueDate) return { error: `${C.date} is required — the day the document was raised.` };

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
    docNumber: group.number,
    placeOfSupplyCode,
    gstTreatment,
    buyerGstin: gstin,
    issueDate: day(issueDate),
    dueDate: day(dueDate),
    validUntil: day(validUntil),
    reference: head.text(C.reference).slice(0, 120),
    salespersonId: salesperson?.id ?? "",
    notes: head.text(C.notes),
    terms: head.text(C.terms),
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
  const total = computeDocument(
    lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, discountMode: l.discountMode, discountValue: l.discountValue, taxRatePercent: l.taxRatePercent })),
    "INTER_STATE",
    { roundOff: false },
  ).total;
  const stated = head.number(C.total);
  if (stated !== undefined && Math.abs(stated - total) > 1) {
    return { error: `Its lines come to ${rupees(total)}, but the file's ${C.total} is ${rupees(stated)}. Check the quantities, rates, discounts and tax rates.` };
  }
  return { input: parsed.data, status: statusOf(type, head.text(C.status)), partyName: party.name, total: Math.round(total * 100) / 100, lineCount: lines.length };
}

/** What the file would bring in, one row per document, writing nothing. */
export async function planDocumentImport(type: DocumentImportType, fileRows: Record<string, string>[]): Promise<ImportPlan> {
  const { rows, readAs } = readHeadings(headings, fileRows);
  const clock = await workspaceClock();
  const planned: PlannedRow[] = [];
  for (const group of groupRows(rows)) {
    const result = await resolveGroup(type, group, clock);
    const label = group.number || `Row ${group.firstLine}`;
    if ("error" in result) {
      planned.push({ line: result.line ?? group.firstLine, action: "error", key: "", label, changes: [], error: result.error });
    } else if ("skip" in result) {
      planned.push({ line: group.firstLine, action: "skip", key: group.number, label, changes: [] });
    } else {
      const changes: FieldChange[] = [
        { field: "Party", from: "(new)", to: result.partyName },
        { field: C.date, from: "(new)", to: result.input.issueDate },
        { field: "Lines", from: "(new)", to: String(result.lineCount) },
        { field: C.total, from: "(new)", to: rupees(result.total) },
        ...(result.status !== "ISSUED" ? [{ field: C.status, from: "(new)", to: result.status.toLowerCase() }] : []),
        ...(result.input.validUntil ? [{ field: C.validUntil, from: "(new)", to: result.input.validUntil }] : []),
        ...(result.input.dueDate ? [{ field: C.due, from: "(new)", to: result.input.dueDate }] : []),
      ];
      planned.push({ line: group.firstLine, action: "create", key: group.number, label: `${group.number} · ${result.partyName}`, changes });
    }
  }
  const known = new Set(DOCUMENT_TEMPLATE_COLUMNS);
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  return {
    area: `documents:${type}`,
    totalRows: planned.length,
    creates: planned.filter((r) => r.action === "create").length,
    updates: 0,
    skips: planned.filter((r) => r.action === "skip").length,
    errors: planned.filter((r) => r.action === "error").length,
    rows: planned,
    unknownColumns: [...present].filter((c) => c && !known.has(c)),
    notices: [],
    readAs,
  };
}

/**
 * Brings the documents in, one at a time: a document that can't be made is named and the rest still
 * land, as every import does. Each is created as the form creates one, then marked as it was there.
 */
export async function applyDocumentImport(type: DocumentImportType, fileRows: Record<string, string>[], actorUserId: string): Promise<Applied> {
  const { rows } = readHeadings(headings, fileRows);
  const clock = await workspaceClock();
  const result: Applied = { created: 0, updated: 0, skipped: 0, failed: [] };
  for (const group of groupRows(rows)) {
    const resolved = await resolveGroup(type, group, clock);
    if ("error" in resolved) {
      result.failed.push({ line: resolved.line ?? group.firstLine, error: resolved.error });
      continue;
    }
    if ("skip" in resolved) {
      result.skipped += 1;
      continue;
    }
    try {
      const made = await createDraftDocument({ id: actorUserId }, resolved.input, "IMPORTED");
      if (!made.ok) {
        result.failed.push({ line: group.firstLine, error: made.error });
        continue;
      }
      // Issued as it was there, on the day it was raised — and nothing that issuing sets off.
      if (resolved.status !== "DRAFT") {
        await db.tradeDocument.update({
          where: { id: made.data.id },
          data: { status: resolved.status, issuedAt: new Date(`${resolved.input.issueDate}T00:00:00Z`), einvoiceStatus: "NOT_APPLICABLE" },
        });
      }
      await recordAudit({
        userId: actorUserId,
        action: "CREATE",
        entityType: "TradeDocument",
        entityId: made.data.id,
        entityLabel: `${tradeDocumentLabels[type]} ${group.number} for ${resolved.partyName} (imported)`,
      });
      result.created += 1;
    } catch (err) {
      result.failed.push({ line: group.firstLine, error: err instanceof Error ? err.message : "Failed to write." });
    }
  }
  return result;
}
