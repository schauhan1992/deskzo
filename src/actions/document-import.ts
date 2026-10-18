"use server";

import { revalidatePath } from "next/cache";
import { isModuleEntitled, requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { parseFile, type ImportPlan } from "@/lib/portability/import";
import { applyDocumentImport, DOCUMENT_TEMPLATE_COLUMNS, isDocumentImportType, planDocumentImport, type DocumentImportType } from "@/lib/portability/documents";
import { documentWriteKey, documentWriteRefusal } from "@/lib/documents/write-permission";
import { documentDirection, tradeDocumentLabels } from "@/lib/trade-documents";
import { csvRow } from "@/lib/csv";
import type { ActionResult } from "@/actions/company";

/**
 * Open documents from the system a company used before Deskzo (owner, 18 Oct 2026) — the preview, the
 * import and the template, from each document list. The documents are src/lib/portability/documents.ts.
 *
 * Who may: whoever may raise that kind of document by hand, and may import finance data — a file of
 * documents is many at once, and these carry money. As with every import, the file is read again on
 * commit and never kept.
 */

const MAX_BYTES = 5 * 1024 * 1024;
type Applied = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };

async function gate(type: unknown): Promise<{ user: { id: string; name: string }; type: DocumentImportType } | { error: string }> {
  if (!isDocumentImportType(type)) return { error: "That kind of document can't be imported yet." };
  // Both named, as the document form's actions name them; then the one this kind of document is in.
  const user = await requireModuleUser(["sales_documents", "purchase_documents"]);
  if (!(await isModuleEntitled(documentDirection[type] === "PURCHASE" ? "purchase_documents" : "sales_documents"))) {
    return { error: `${tradeDocumentLabels[type]}s aren't part of this workspace's plan.` };
  }
  if (!(await can(user.id, documentWriteKey(type, "issue")))) return { error: documentWriteRefusal(type, "issue") };
  if (!(await can(user.id, "data.importFinance"))) return { error: "Importing documents needs the right to import finance data." };
  return { user, type };
}

function fileRefusal(input: { filename: string; base64: string }) {
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) return `That file is over ${MAX_BYTES / 1024 / 1024}MB. Split it and import in batches.`;
  if (!/\.(csv|xlsx)$/i.test(input.filename)) return "Use a .csv or .xlsx file.";
  return null;
}

export async function previewDocumentImport(input: { type: string; filename: string; base64: string }): Promise<ActionResult<ImportPlan>> {
  const gated = await gate(input.type);
  if ("error" in gated) return { ok: false, error: gated.error };
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    return { ok: true, data: await planDocumentImport(gated.type, rows) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `Couldn't read that file: ${err.message}` : "Couldn't read that file." };
  }
}

export async function commitDocumentImport(input: { type: string; filename: string; base64: string }): Promise<ActionResult<Applied>> {
  const gated = await gate(input.type);
  if ("error" in gated) return { ok: false, error: gated.error };
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  const { user, type } = gated;
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    const result = await applyDocumentImport(type, rows, user.id);
    const label = tradeDocumentLabels[type].toLowerCase();
    const summary =
      `${user.name} brought open ${label}s across from ${input.filename}: ${result.created} imported, ${result.skipped} already here` +
      (result.failed.length ? `, ${result.failed.length} failed` : "");
    // Both trails, as the other imports keep them (src/actions/data-import.ts); each document has its own audit row too.
    await logActivity({
      kind: "EXPORT",
      severity: result.failed.length ? "WARNING" : "NOTICE",
      summary,
      metadata: { direction: "import", area: `documents:${type}`, file: input.filename, created: result.created, failed: result.failed.length },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Import", entityId: `documents:${type}`, entityLabel: summary });
    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
  }
}

/** The template's headings: Deskzo's names, which the usual ones from other systems are read as. */
export async function documentImportTemplate(type: string): Promise<ActionResult<{ filename: string; csv: string }>> {
  const gated = await gate(type);
  if ("error" in gated) return { ok: false, error: gated.error };
  const slug = tradeDocumentLabels[gated.type].toLowerCase().replace(/\s+/g, "-");
  return { ok: true, data: { filename: `${slug}-import-template.csv`, csv: csvRow(DOCUMENT_TEMPLATE_COLUMNS) + "\n" } };
}
