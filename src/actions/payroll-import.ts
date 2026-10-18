"use server";

import { revalidatePath } from "next/cache";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { applyWith, parseFile, planWith, type ImportPlan } from "@/lib/portability/import";
import { payrollImporter } from "@/lib/portability/importers/payroll";
import { csvRow } from "@/lib/csv";
import type { ActionResult } from "@/actions/company";

/**
 * Bringing pay across from another HRMS (roadmap 1.13; owner, 18 Oct 2026) — the preview, the import
 * and the template, for payroll only. The rows are src/lib/portability/importers/payroll.ts.
 *
 * Payroll managers only (`payroll.manage`), whatever else the person may import: the file sets what
 * everybody earns and where it's paid. As with every import, the file is read again on commit rather
 * than a plan carried between calls, and it is never kept.
 */

const AREA = "payroll";
const MAX_BYTES = 5 * 1024 * 1024;

type Applied = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };

async function gate() {
  const user = await requireModuleUser("payroll");
  if (!(await hasEffectivePermission(user.id, "payroll.manage"))) return { user, error: "Only payroll can bring pay across from another system." };
  return { user, error: null };
}

function fileRefusal(input: { filename: string; base64: string }) {
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) return `That file is over ${MAX_BYTES / 1024 / 1024}MB. Split it and import in batches.`;
  if (!/\.(csv|xlsx)$/i.test(input.filename)) return "Use a .csv or .xlsx file.";
  return null;
}

export async function previewPayrollImport(input: { filename: string; base64: string }): Promise<ActionResult<ImportPlan>> {
  const { user, error } = await gate();
  if (error) {
    await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} tried to import pay without payroll rights` });
    return { ok: false, error };
  }
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    return { ok: true, data: await planWith(payrollImporter, AREA, rows, user.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `Couldn't read that file: ${err.message}` : "Couldn't read that file." };
  }
}

export async function commitPayrollImport(input: { filename: string; base64: string }): Promise<ActionResult<Applied>> {
  const { user, error } = await gate();
  if (error) return { ok: false, error };
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    const result = await applyWith(payrollImporter, AREA, rows, user.id);

    const summary =
      `${user.name} brought pay across from ${input.filename}: ` +
      `${result.created} new ${result.created === 1 ? "salary" : "salaries"}, ${result.updated} ${result.updated === 1 ? "person" : "people"} updated, ${result.skipped} unchanged` +
      (result.failed.length ? `, ${result.failed.length} failed` : "");
    // Both trails, as the other imports keep them (src/actions/data-import.ts); each person's change has its own audit row too.
    await logActivity({
      kind: "EXPORT",
      severity: result.failed.length ? "WARNING" : "NOTICE",
      summary,
      metadata: { direction: "import", area: AREA, file: input.filename, created: result.created, updated: result.updated, failed: result.failed.length },
    });
    await recordAudit({ userId: user.id, action: result.created > 0 ? "CREATE" : "UPDATE", entityType: "Import", entityId: AREA, entityLabel: summary });

    revalidatePath("/people/payroll");
    revalidatePath("/people");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
  }
}

/** The template's headings: Deskzo's names, which the usual ones from other systems are read as. */
export async function payrollImportTemplate(): Promise<ActionResult<{ filename: string; csv: string }>> {
  const { error } = await gate();
  if (error) return { ok: false, error };
  return { ok: true, data: { filename: "payroll-import-template.csv", csv: csvRow(payrollImporter.templateColumns) + "\n" } };
}
