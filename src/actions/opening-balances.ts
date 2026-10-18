"use server";

import { revalidatePath } from "next/cache";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { parseFile, type ImportPlan } from "@/lib/portability/import";
import { applyOpeningBalances, OPENING_TEMPLATE_COLUMNS, planOpeningBalances } from "@/lib/portability/opening-balances";
import { csvRow } from "@/lib/csv";
import type { ActionResult } from "@/actions/company";

/**
 * Opening balances from one file, posted as one journal entry on the day the books start (owner, 18 Oct
 * 2026) — the preview, the import and the template, from the Journal. The entry is
 * src/lib/portability/opening-balances.ts.
 *
 * Who may: whoever may post a journal by hand (`ledger.post`, what a typed opening entry already needs)
 * and import finance data. The file is read again on commit and never kept.
 */

const MAX_BYTES = 5 * 1024 * 1024;
type Applied = { created: number; updated: number; skipped: number; failed: { line: number; error: string }[] };
type OpeningFile = { filename: string; base64: string; openingDate?: string | null };

async function gate(): Promise<{ user: { id: string; name: string } } | { error: string }> {
  const user = await requireModuleUser("accounting");
  if (!(await can(user.id, "ledger.post"))) return { error: "Importing opening balances needs the right to post journal entries." };
  if (!(await can(user.id, "data.importFinance"))) return { error: "Importing opening balances needs the right to import finance data." };
  return { user };
}

function fileRefusal(input: { filename: string; base64: string }) {
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) return `That file is over ${MAX_BYTES / 1024 / 1024}MB.`;
  if (!/\.(csv|xlsx)$/i.test(input.filename)) return "Use a .csv or .xlsx file.";
  return null;
}

export async function previewOpeningBalances(input: OpeningFile): Promise<ActionResult<ImportPlan>> {
  const gated = await gate();
  if ("error" in gated) return { ok: false, error: gated.error };
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    return { ok: true, data: await planOpeningBalances(rows, { openingDate: input.openingDate, filename: input.filename }) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't read that file." };
  }
}

export async function commitOpeningBalances(input: OpeningFile): Promise<ActionResult<Applied>> {
  const gated = await gate();
  if ("error" in gated) return { ok: false, error: gated.error };
  const refusal = fileRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  const { user } = gated;
  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    const result = await applyOpeningBalances(rows, user.id, { openingDate: input.openingDate, filename: input.filename });
    const summary = result.entryNumber
      ? `${user.name} imported opening balances from ${input.filename} as ${result.entryNumber}: ${result.created} lines`
      : `${user.name} tried to import opening balances from ${input.filename}: ${result.failed.length} unusable row(s), nothing posted`;
    // Both trails, as the other imports keep them (src/actions/data-import.ts); the entry has its own audit row too.
    await logActivity({
      kind: "EXPORT",
      severity: result.failed.length ? "WARNING" : "NOTICE",
      summary,
      metadata: { direction: "import", area: "opening-balances", file: input.filename, created: result.created, failed: result.failed.length },
    });
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Import", entityId: "opening-balances", entityLabel: summary });
    revalidatePath("/accounting", "layout");
    return { ok: true, data: { created: result.created, updated: 0, skipped: result.skipped, failed: result.failed } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
  }
}

/** The template's headings: Deskzo's names, which the usual ones from a trial balance export are read as. */
export async function openingBalancesTemplate(): Promise<ActionResult<{ filename: string; csv: string }>> {
  const gated = await gate();
  if ("error" in gated) return { ok: false, error: gated.error };
  return { ok: true, data: { filename: "opening-balances-template.csv", csv: csvRow(OPENING_TEMPLATE_COLUMNS) + "\n" } };
}
