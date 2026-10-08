"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { parseFile } from "@/lib/portability/import";
import { PdfStatementRefused, parsePdfStatement } from "@/lib/reconcile/pdf";
import { reconcile, type Billing } from "@/lib/reconcile/match";
import { applyMapping, guessMapping, missingRequired, type ColumnMapping } from "@/lib/reconcile/mapping";
import { catalogueSkus, soldInPeriod } from "@/lib/reconcile/data";
import { parseManualRows, type ManualRow } from "@/lib/reconcile/manual";
import type { ActionResult } from "@/actions/company";

/**
 * Uploading a distributor's statement and comparing it against what we sold.
 *
 * Two steps that cannot be collapsed, for the same reason the data importer keeps them apart:
 * `previewStatement` reads the file and reports what it found, writing nothing, and `commitStatement`
 * carries it out. The preview is where a wrong column mapping is caught, and a wrong column mapping
 * silently turns two hundred correct lines into two hundred exceptions.
 *
 * The file is re-parsed on commit rather than the preview being handed back in. It costs a second,
 * and it means what is stored is what is in the file rather than a client-supplied object shaped
 * like a result — which a `"use server"` action must never trust.
 */

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * The statement's rows, keyed by its column headings: a spreadsheet as the data importer reads one,
 * a PDF by rebuilding its table from where the words sit (src/lib/reconcile/pdf.ts). A PDF that can't
 * be read throws `PdfStatementRefused`, whose words are for the person.
 */
async function readStatement(base64: string, filename: string): Promise<Record<string, string>[]> {
  if (/\.pdf$/i.test(filename)) return parsePdfStatement(new Uint8Array(Buffer.from(base64, "base64")));
  return parseFile(base64, filename);
}

async function gate() {
  const user = await requireModuleUser("purchase_documents");
  if (!(await can(user.id, "purchase.reconcile"))) {
    return { user, error: "You don't have access to vendor reconciliation." };
  }
  return { user, error: null };
}

export type StatementPreview = {
  headers: string[];
  mapping: ColumnMapping;
  missing: string[];
  rowCount: number;
  problems: { rowNumber: number; reason: string }[];
  /** The first few rows as mapped, so somebody can see the mapping is right before committing. */
  sample: { sku: string; customerRef: string; quantity: number; unitCost: number; lineTotal: number }[];
  summary: ReturnType<typeof reconcile>["summary"] | null;
  totalBilled: number;
};

export async function previewStatement(input: {
  filename: string;
  base64: string;
  periodStart: string;
  periodEnd: string;
  billing: Billing;
  complete?: boolean;
  /** Null on the first look: the columns are guessed, and the guess comes back for correcting. */
  mapping?: ColumnMapping | null;
  /** Used only to recall this vendor's saved mapping. */
  vendorId?: string | null;
}): Promise<ActionResult<StatementPreview>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) {
    return { ok: false, error: `That file is over ${MAX_BYTES / 1024 / 1024}MB. Split it and upload in parts.` };
  }
  if (!/\.(csv|xlsx|pdf)$/i.test(input.filename)) {
    return { ok: false, error: "Use a .csv, .xlsx or .pdf file." };
  }

  const period = { start: new Date(input.periodStart), end: new Date(input.periodEnd) };
  if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime())) {
    return { ok: false, error: "Give the period this statement covers." };
  }
  if (period.end < period.start) {
    return { ok: false, error: "The period ends before it starts." };
  }

  let rows: Record<string, string>[];
  try {
    rows = await readStatement(input.base64, input.filename);
  } catch (err) {
    if (err instanceof PdfStatementRefused) return { ok: false, error: err.message };
    return { ok: false, error: err instanceof Error ? `Couldn't read that file: ${err.message}` : "Couldn't read that file." };
  }
  if (rows.length === 0) return { ok: false, error: "That file has no rows." };

  const headers = Object.keys(rows[0]!);

  /**
   * Where the mapping comes from, in order: what was just corrected on screen, then what this
   * vendor's last statement used, then a guess. The saved mapping is why the second upload is a
   * click rather than the same twenty minutes of column-picking as the first.
   */
  const saved = input.vendorId
    ? await db.vendorStatementMapping.findUnique({ where: { vendorId: input.vendorId }, select: { columns: true } })
    : null;
  const mapping: ColumnMapping =
    input.mapping ?? ((saved?.columns as ColumnMapping | undefined) || guessMapping(headers));

  // A saved mapping from a file with different columns is worse than no mapping, so anything
  // naming a column this file does not have is dropped back to the guess.
  const usable: ColumnMapping = Object.fromEntries(
    Object.entries(mapping).filter(([, column]) => column && headers.includes(column)),
  );
  const effective = Object.keys(usable).length > 0 ? usable : guessMapping(headers);

  const missing = missingRequired(effective);
  const mapped = applyMapping(rows, effective);

  if (missing.length > 0) {
    // Reported rather than refused: the screen needs the headers back to offer the pickers.
    return {
      ok: true,
      data: {
        headers,
        mapping: effective,
        missing,
        rowCount: rows.length,
        problems: mapped.problems,
        sample: [],
        summary: null,
        totalBilled: 0,
      },
    };
  }

  const [sold, skus] = await Promise.all([soldInPeriod(period), catalogueSkus()]);
  const result = reconcile(
    mapped.rows.map((m) => m.row),
    sold,
    period,
    {
      billing: input.billing,
      catalogSkus: skus,
      vendorId: input.vendorId ?? null,
      reportMissing: input.complete ?? true,
    },
  );

  return {
    ok: true,
    data: {
      headers,
      mapping: effective,
      missing: [],
      rowCount: rows.length,
      problems: mapped.problems,
      sample: mapped.rows.slice(0, 5).map((m) => ({
        sku: m.row.sku,
        customerRef: m.row.customerRef,
        quantity: m.row.quantity,
        unitCost: m.row.unitCost,
        lineTotal: m.row.lineTotal,
      })),
      summary: result.summary,
      totalBilled: Math.round(mapped.rows.reduce((sum, m) => sum + m.row.lineTotal, 0) * 100) / 100,
    },
  };
}

type PreparedLine = { row: import("@/lib/reconcile/match").StatementRow; raw: Record<string, string> | null };

/**
 * Runs the comparison and writes it down.
 *
 * Shared by both doors — an uploaded file and a typed grid — because the only difference between
 * them is where the rows came from. Two copies of this would be two sets of rules about what counts
 * as a match, and they would diverge the first time either was touched.
 */
async function storeStatement(params: {
  userId: string;
  vendorId: string;
  vendorName: string;
  label: string;
  filename: string | null;
  period: { start: Date; end: Date };
  billing: Billing;
  complete: boolean;
  prepared: PreparedLine[];
  notes?: string | null;
  mapping?: ColumnMapping | null;
}): Promise<{ statementId: string; exceptions: number; atRisk: number }> {
  const [sold, skus] = await Promise.all([soldInPeriod(params.period), catalogueSkus()]);
  const result = reconcile(
    params.prepared.map((p) => p.row),
    sold,
    params.period,
    { billing: params.billing, catalogSkus: skus, vendorId: params.vendorId, reportMissing: params.complete },
  );

  const rawByRow = new Map(params.prepared.map((p) => [p.row.rowNumber, p.raw]));
  const totalBilled = params.prepared.reduce((sum, p) => sum + p.row.lineTotal, 0);

  const statement = await db.$transaction(async (tx) => {
    const created = await tx.vendorStatement.create({
      data: {
        vendorId: params.vendorId,
        label: params.label,
        periodStart: params.period.start,
        periodEnd: params.period.end,
        billing: params.billing,
        complete: params.complete,
        filename: params.filename,
        lineCount: params.prepared.length,
        totalBilled: new Prisma.Decimal(totalBilled.toFixed(2)),
        notes: params.notes?.trim() || null,
        uploadedById: params.userId,
      },
      select: { id: true },
    });

    await tx.vendorStatementLine.createMany({
      data: result.lines.map((line) => ({
        statementId: created.id,
        source: line.source,
        rowNumber: line.rowNumber,
        sku: line.sku,
        customerRef: line.customerRef,
        quantity: line.quantity,
        unitCost: new Prisma.Decimal(line.unitCost.toFixed(2)),
        lineTotal: new Prisma.Decimal(line.lineTotal.toFixed(2)),
        raw: line.rowNumber ? ((rawByRow.get(line.rowNumber) ?? null) as Prisma.InputJsonValue) : Prisma.JsonNull,
        state: line.state,
        matchedOrderId: line.matchedOrderId,
        matchedCompanyId: line.matchedCompanyId,
        variance: new Prisma.Decimal(line.variance.toFixed(2)),
        note: line.note || null,
      })),
    });

    // Remembered for next month. Only for an uploaded file — there are no columns to remember when
    // somebody typed the lines, and overwriting a good mapping with nothing would cost them the
    // twenty minutes it exists to save.
    if (params.mapping) {
      await tx.vendorStatementMapping.upsert({
        where: { vendorId: params.vendorId },
        create: { vendorId: params.vendorId, columns: params.mapping as Prisma.InputJsonValue, updatedById: params.userId },
        update: { columns: params.mapping as Prisma.InputJsonValue, updatedById: params.userId },
      });
    }

    return created;
  });

  await recordAudit({
    userId: params.userId,
    action: "CREATE",
    entityType: "VendorStatement",
    entityId: statement.id,
    entityLabel: `${params.vendorName} — ${params.label}`,
  });

  revalidatePath("/purchase/reconciliation");
  return { statementId: statement.id, exceptions: result.summary.exceptions, atRisk: result.summary.atRisk };
}

/** Shared validation for both doors. */
async function checkCommon(input: { vendorId: string; label: string; periodStart: string; periodEnd: string }) {
  if (!input.vendorId) return { error: "Choose which vendor this statement is from." as const, vendor: null, period: null };
  if (!input.label.trim()) return { error: "Give this statement a name." as const, vendor: null, period: null };

  const vendor = await db.company.findUnique({ where: { id: input.vendorId }, select: { id: true, name: true } });
  if (!vendor) return { error: "That vendor no longer exists." as const, vendor: null, period: null };

  const period = { start: new Date(input.periodStart), end: new Date(input.periodEnd) };
  if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime()) || period.end < period.start) {
    return { error: "Give a valid period for this statement." as const, vendor: null, period: null };
  }
  return { error: null, vendor, period };
}

export async function commitStatement(input: {
  vendorId: string;
  label: string;
  filename: string;
  base64: string;
  periodStart: string;
  periodEnd: string;
  billing: Billing;
  complete?: boolean;
  mapping: ColumnMapping;
  notes?: string | null;
}): Promise<ActionResult<{ statementId: string; exceptions: number; atRisk: number }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (missingRequired(input.mapping).length > 0) {
    return { ok: false, error: "Map the SKU, customer and quantity columns before importing." };
  }

  const common = await checkCommon(input);
  if (common.error) return { ok: false, error: common.error };
  const { vendor, period } = common;

  let rows: Record<string, string>[];
  try {
    rows = await readStatement(input.base64, input.filename);
  } catch (err) {
    return { ok: false, error: err instanceof PdfStatementRefused ? err.message : "Couldn't read that file." };
  }

  const mapped = applyMapping(rows, input.mapping);
  if (mapped.rows.length === 0) return { ok: false, error: "No usable rows in that file." };

  const stored = await storeStatement({
    userId: user.id,
    vendorId: vendor!.id,
    vendorName: vendor!.name,
    label: input.label.trim(),
    filename: input.filename,
    period: period!,
    billing: input.billing,
    complete: input.complete ?? true,
    prepared: mapped.rows.map((m) => ({ row: m.row, raw: m.raw })),
    notes: input.notes,
    mapping: input.mapping,
  });

  return { ok: true, data: stored };
}

/**
 * The same comparison, on rows somebody typed or pasted.
 *
 * Writes nothing — this is the preview behind the grid, so a typo is seen before it is stored.
 */
export async function previewManualStatement(input: {
  rows: ManualRow[];
  periodStart: string;
  periodEnd: string;
  billing: Billing;
  complete?: boolean;
  vendorId?: string | null;
}): Promise<ActionResult<{ summary: ReturnType<typeof reconcile>["summary"]; problems: { rowNumber: number; reason: string }[]; totalBilled: number; usable: number }>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  if (input.rows.length > 500) {
    return { ok: false, error: "That is more than 500 lines — upload it as a file instead." };
  }

  const period = { start: new Date(input.periodStart), end: new Date(input.periodEnd) };
  if (Number.isNaN(period.start.getTime()) || Number.isNaN(period.end.getTime()) || period.end < period.start) {
    return { ok: false, error: "Give the period this statement covers." };
  }

  const parsed = parseManualRows(input.rows);
  if (parsed.rows.length === 0) {
    return {
      ok: true,
      data: { summary: reconcile([], [], period).summary, problems: parsed.problems, totalBilled: 0, usable: 0 },
    };
  }

  const [sold, skus] = await Promise.all([soldInPeriod(period), catalogueSkus()]);
  const result = reconcile(parsed.rows, sold, period, {
    billing: input.billing,
    catalogSkus: skus,
    vendorId: input.vendorId ?? null,
    // Typed lines are a spot check unless somebody says otherwise, which is the opposite default
    // from a file: nobody types out a whole month.
    reportMissing: input.complete ?? false,
  });

  return {
    ok: true,
    data: {
      summary: result.summary,
      problems: parsed.problems,
      totalBilled: Math.round(parsed.rows.reduce((sum, r) => sum + r.lineTotal, 0) * 100) / 100,
      usable: parsed.rows.length,
    },
  };
}

/**
 * Stores a typed statement.
 *
 * The rows arrive from the client, which is unavoidable — nobody typed them onto the server. What
 * matters is that the *verdicts* do not: this re-runs `reconcile` here rather than accepting any
 * judgement the browser sends, exactly as the file path re-parses the file rather than trusting the
 * preview it handed out.
 */
export async function commitManualStatement(input: {
  vendorId: string;
  label: string;
  rows: ManualRow[];
  periodStart: string;
  periodEnd: string;
  billing: Billing;
  complete?: boolean;
  notes?: string | null;
}): Promise<ActionResult<{ statementId: string; exceptions: number; atRisk: number }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (input.rows.length > 500) {
    return { ok: false, error: "That is more than 500 lines — upload it as a file instead." };
  }

  const common = await checkCommon(input);
  if (common.error) return { ok: false, error: common.error };
  const { vendor, period } = common;

  const parsed = parseManualRows(input.rows);
  if (parsed.rows.length === 0) {
    return { ok: false, error: "There are no usable lines to reconcile." };
  }

  const stored = await storeStatement({
    userId: user.id,
    vendorId: vendor!.id,
    vendorName: vendor!.name,
    label: input.label.trim(),
    // Null rather than a made-up name: the list then says "entered by hand" because it is true,
    // rather than because somebody typed that into a filename box.
    filename: null,
    period: period!,
    billing: input.billing,
    complete: input.complete ?? false,
    prepared: parsed.rows.map((row) => ({ row, raw: null })),
    notes: input.notes,
    mapping: null,
  });

  return { ok: true, data: stored };
}

/**
 * Clears one exception, with a reason.
 *
 * Not a state change: a resolved seat mismatch is still a seat mismatch, and next month's statement
 * will say so again if nothing was actually fixed. Recording *why* it was cleared is the whole
 * point — "raised invoice INV-1043" and "distributor credited us" are both resolutions, and only
 * one of them means the underlying problem has gone away.
 */
export async function resolveLine(input: { lineId: string; note: string }): Promise<ActionResult<{ resolved: boolean }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  if (!input.note.trim()) return { ok: false, error: "Say what was done about it." };

  const line = await db.vendorStatementLine.findUnique({
    where: { id: input.lineId },
    select: { id: true, statementId: true, sku: true },
  });
  if (!line) return { ok: false, error: "That line no longer exists." };

  await db.vendorStatementLine.update({
    where: { id: line.id },
    data: { resolvedAt: new Date(), resolvedById: user.id, resolutionNote: input.note.trim() },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "VendorStatementLine",
    entityId: line.id,
    entityLabel: `Cleared ${line.sku}`,
  });

  revalidatePath(`/purchase/reconciliation/${line.statementId}`);
  return { ok: true, data: { resolved: true } };
}

export async function reopenLine(input: { lineId: string }): Promise<ActionResult<{ resolved: boolean }>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const line = await db.vendorStatementLine.findUnique({
    where: { id: input.lineId },
    select: { id: true, statementId: true },
  });
  if (!line) return { ok: false, error: "That line no longer exists." };

  await db.vendorStatementLine.update({
    where: { id: line.id },
    data: { resolvedAt: null, resolvedById: null, resolutionNote: null },
  });

  revalidatePath(`/purchase/reconciliation/${line.statementId}`);
  return { ok: true, data: { resolved: false } };
}

export async function deleteStatement(input: { statementId: string }): Promise<ActionResult<{ deleted: boolean }>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };

  const statement = await db.vendorStatement.findUnique({
    where: { id: input.statementId },
    select: { id: true, label: true, vendor: { select: { name: true } } },
  });
  if (!statement) return { ok: false, error: "That statement no longer exists." };

  // Lines cascade. Nothing here is a source record — it is all derived from a file somebody still
  // has — so a delete is a re-import away rather than a loss.
  await db.vendorStatement.delete({ where: { id: statement.id } });

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "VendorStatement",
    entityId: statement.id,
    entityLabel: `${statement.vendor.name} — ${statement.label}`,
  });

  revalidatePath("/purchase/reconciliation");
  return { ok: true, data: { deleted: true } };
}

/** Vendors to pick from. Anyone this business buys from, newest activity first. */
export async function reconcilableVendors(): Promise<ActionResult<{ id: string; name: string }[]>> {
  const { error } = await gate();
  if (error) return { ok: false, error };

  const vendors = await db.company.findMany({
    where: { relationshipType: { in: ["VENDOR", "OEM", "DISTRIBUTOR"] } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return { ok: true, data: vendors };
}
