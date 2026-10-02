import ExcelJS from "exceljs";
import { formatContactId, formatLeadId } from "@/lib/order-id";
import { db } from "@/lib/db";
import { accountScopeIds } from "@/lib/authz/company-scope";
import { seesResellerContactDetails } from "@/lib/authz/contact-access";
import { sanitizeCsvCell } from "@/lib/csv";
import { isResellerManaged, redactContactDetails } from "@/lib/reseller";
import { getExporter } from "./exporters";

/**
 * Turning the canonical entities into a file somebody can open.
 *
 * ## Two shapes, for two different jobs
 *
 * **One area, one sheet** — "give me every contact" — is a list, and a list is a CSV or a single
 * worksheet. That is the routine export.
 *
 * **One account, everything attached** is a different thing: a workbook where each sheet is a
 * relationship. Contacts, orders, payments, tickets, visits, documents. Flattening that into one
 * sheet would repeat the company on every row and lose which records belong to which relationship;
 * one sheet per relationship keeps it legible and is what a person actually wants when they ask for
 * "everything about this customer".
 *
 * ## Scope is inherited, never widened
 *
 * Every query here runs through the same account scoping the screens use. An export returns exactly
 * the rows the person could already see. The permission decides whether they may take those rows
 * out of the building, which is a different question from what they may look at, and this file must
 * never be the place the two get confused.
 */

/**
 * A value as a spreadsheet cell.
 *
 * Deliberately **not** run through `sanitizeCsvCell`. That guard exists because a CSV is plain text
 * and Excel decides for itself whether a cell starting with `=` is a formula; in an xlsx the cell
 * carries its own type, so a string is stored as a string and there is nothing to guard against.
 * Applying it here instead corrupted the data — a part number of `-X1` came back as `'-X1`, and
 * re-importing the file we had just exported wrote the apostrophe into the record.
 */
function cell(value: unknown): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sheetFrom(workbook: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]) {
  // Excel refuses sheet names over 31 characters or containing : \ / ? * [ ]
  const safe = name.replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
  const sheet = workbook.addWorksheet(safe);
  if (rows.length === 0) {
    sheet.addRow(["(none)"]);
    return sheet;
  }
  const headers = Object.keys(rows[0]!);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const r of rows) sheet.addRow(headers.map((h) => cell(r[h])));
  // Enough width to read without clicking into each cell, capped so one long note does not make a
  // column wider than the screen.
  sheet.columns.forEach((col) => {
    let max = 10;
    col.eachCell?.({ includeEmpty: false }, (c) => {
      max = Math.min(60, Math.max(max, String(c.value ?? "").length + 2));
    });
    col.width = max;
  });
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return sheet;
}

export async function toWorkbookBuffer(
  sheets: { name: string; rows: Record<string, unknown>[] }[],
  meta: { title: string; by: string; generatedAt: Date },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Deskzo One";
  wb.created = meta.generatedAt;

  // A cover sheet, because an exported file outlives the conversation that produced it. Six months
  // on, the useful questions are what this is, when it was taken, who took it, and whether it is
  // everything or only what one person could see.
  sheetFrom(wb, "About this export", [
    { Field: "Export", Value: meta.title },
    { Field: "Taken", Value: meta.generatedAt.toISOString() },
    { Field: "By", Value: meta.by },
    { Field: "Source", Value: "Deskzo One" },
    {
      Field: "Scope",
      Value:
        "Only the accounts the person taking this export could see. Not necessarily the whole database.",
    },
    { Field: "Sheets", Value: sheets.map((s) => s.name).join(", ") },
  ]);

  for (const s of sheets) sheetFrom(wb, s.name, s.rows);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The same rows as plain text.
 *
 * Two things differ from the workbook and both are about CSV having no types. Dates are written as
 * ISO rather than left to `String(date)`, which would emit "Thu Jun 05 2025 05:30:00 GMT+0530" — a
 * local-timezone string that reads back as the previous day west of here. And strings go through
 * `sanitizeCsvCell`, because Excel opening a text file decides for itself what is a formula; the
 * import side removes that marker again, so the round trip still holds.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]!);
  const text = (v: unknown) => {
    const c = cell(v);
    if (c === null) return "";
    if (c instanceof Date) return c.toISOString();
    if (typeof c === "string") return sanitizeCsvCell(c);
    return String(c);
  };
  const line = (values: unknown[]) => values.map((v) => `"${text(v).replaceAll('"', '""')}"`).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h])))].join("\n");
}

// ─── The queries ────────────────────────────────────────────────────────────────────────────────

/**
 * Every relationship hanging off one account, as sheets.
 *
 * This is the "export a customer and get everything" case. Each sheet is deliberately flat — a
 * target system or a person with a spreadsheet can work with flat; neither can work with nesting.
 */
export async function accountBundle(userId: string, companyId: string) {
  const ids = await accountScopeIds(userId);
  const company = await db.company.findFirst({
    where: { id: companyId, ...(ids === null ? {} : { ownerUserId: { in: ids } }) },
    include: {
      owner: { select: { name: true, email: true } },
      assignedTo: { select: { name: true } },
      industry: { select: { name: true } },
      managedByReseller: { select: { name: true } },
      locations: true,
      contacts: true,
    },
  });
  // Null covers both "no such company" and "not yours" on purpose: telling somebody a record exists
  // but is not theirs is itself a disclosure.
  if (!company) return null;
  // A reseller's end customer's contact details leave only with somebody who may see them
  // (src/lib/authz/contact-access.ts), as on the screens.
  const restricted = isResellerManaged(company);
  const canViewRestricted = restricted ? await seesResellerContactDetails(userId) : true;
  const contacts = company.contacts.map((c) => redactContactDetails(c, { restricted, canViewRestricted }));

  const [orders, payments, tickets, visits, documents, leads] = await Promise.all([
    db.companyProduct.findMany({
      where: { companyId },
      include: { item: { select: { name: true, sku: true } }, vendor: { select: { name: true } }, addedBy: { select: { name: true } } },
      orderBy: { orderSeq: "asc" },
    }),
    db.payment.findMany({ where: { companyId }, include: { recordedBy: { select: { name: true } } }, orderBy: { paidOn: "asc" } }),
    db.ticket.findMany({ where: { companyId }, include: { assignedTo: { select: { name: true } } }, orderBy: { ticketSeq: "asc" } }),
    db.visit.findMany({ where: { companyId }, include: { user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
    db.tradeDocument.findMany({ where: { companyId }, orderBy: { createdAt: "asc" } }),
    db.lead.findMany({ where: { companyId }, include: { owner: { select: { name: true } } }, orderBy: { leadSeq: "asc" } }),
  ]);

  return {
    company,
    sheets: [
      {
        name: "Account",
        rows: [
          {
            Name: company.name,
            Key: company.normalizedName,
            Type: company.relationshipType,
            "Managed by reseller": company.managedByReseller?.name ?? "",
            Stage: company.stage,
            Industry: company.industry?.name ?? "",
            Source: company.source ?? "",
            "Account manager": company.owner?.name ?? "",
            "Assigned to": company.assignedTo?.name ?? "",
            Website: company.website ?? "",
            "Added on": company.createdAt,
          },
        ],
      },
      {
        name: "Locations",
        rows: company.locations.map((l) => ({
          Label: l.label,
          Primary: l.isPrimary,
          GSTIN: l.gstNumber ?? "",
          "GST treatment": l.gstTreatment,
          Address: l.address ?? "",
          City: l.city ?? "",
          State: l.state ?? "",
          Pincode: l.pincode ?? "",
        })),
      },
      {
        name: "Contacts",
        rows: contacts.map((c) => ({
          Key: formatContactId(c.contactSeq),
          Name: c.name,
          Designation: c.designation,
          Email: c.email ?? "",
          Phone: c.phone ?? "",
          Primary: c.isPrimary,
          "Email status": c.detailsRedacted ? "" : c.emailStatus,
        })),
      },
      {
        name: "Orders",
        rows: orders.map((o) => ({
          Order: `ORD-${String(o.orderSeq).padStart(6, "0")}`,
          Item: o.item.name,
          SKU: o.item.sku ?? "",
          Quantity: o.quantity,
          "Unit price": o.unitPrice ? Number(o.unitPrice) : null,
          "Full-term price": o.fullTermUnitPrice ? Number(o.fullTermUnitPrice) : null,
          Status: o.orderStatus,
          Type: o.businessType,
          Vendor: o.vendor?.name ?? "",
          Starts: o.startDate,
          Expires: o.endDate,
          "PO number": o.poNumber ?? "",
          "Added by": o.addedBy.name,
        })),
      },
      {
        name: "Payments",
        rows: payments.map((p) => ({
          Payment: `PAY-${String(p.paymentSeq).padStart(6, "0")}`,
          Amount: Number(p.amount),
          "Paid on": p.paidOn,
          Method: p.method,
          Reference: p.reference ?? "",
          "Recorded by": p.recordedBy?.name ?? "",
        })),
      },
      {
        name: "Leads",
        rows: leads.map((l) => ({
          Lead: formatLeadId(l.leadSeq),
          Title: l.title,
          Status: l.status,
          Value: l.estimatedValue ? Number(l.estimatedValue) : null,
          Owner: l.owner?.name ?? "",
          "Expected close": l.expectedCloseDate,
        })),
      },
      {
        name: "Tickets",
        rows: tickets.map((t) => ({
          Ticket: `TKT-${String(t.ticketSeq).padStart(6, "0")}`,
          Title: t.title,
          Status: t.status,
          Priority: t.priority,
          "Assigned to": t.assignedTo?.name ?? "",
          Raised: t.createdAt,
        })),
      },
      {
        name: "Visits",
        rows: visits.map((v) => ({
          Visit: v.visitSeq ? `VIS-${String(v.visitSeq).padStart(6, "0")}` : "",
          Status: v.status,
          By: v.user?.name ?? "",
          Planned: v.scheduledFor,
          "Checked in": v.checkInAt,
        })),
      },
      {
        name: "Documents",
        rows: documents.map((d) => ({
          Number: d.docNumber ?? "(draft)",
          Kind: d.docType,
          Status: d.status,
          Date: d.issueDate,
          Total: d.total ? Number(d.total) : null,
          IRN: d.irn ?? "",
        })),
      },
    ],
  };
}

/** A single area as one flat list, scoped to what this person may see. */
export async function areaRows(userId: string, area: string): Promise<Record<string, unknown>[]> {
  const exporter = getExporter(area);
  if (!exporter) return [];
  return exporter({ userId, ownerUserIds: await accountScopeIds(userId) });
}
