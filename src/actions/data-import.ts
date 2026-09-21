"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { getArea } from "@/lib/portability/areas";
import { parseFile, plan, apply, IMPLEMENTED_IMPORTS, TEMPLATE_COLUMNS, type ImportPlan } from "@/lib/portability/import";
import type { ActionResult } from "@/actions/company";

/**
 * Two steps, and they cannot be collapsed into one.
 *
 * `previewImport` reads the file and reports exactly what would happen, writing nothing.
 * `commitImport` carries it out. The separation is the whole safety property: a bad import
 * overwrites records that were correct and does it across thousands of rows in a second, and the
 * person who notices is usually a customer, weeks later.
 *
 * The file is re-parsed on commit rather than the plan being carried between calls. It costs a
 * second and it means the thing written is the thing in the file, not a client-supplied object
 * shaped like a plan — which a `"use server"` action must never trust.
 */

const MAX_BYTES = 5 * 1024 * 1024;

async function gate(areaKey: string) {
  const user = await requireUser();
  const area = getArea(areaKey);
  if (!area) return { user, area: null, error: "Unknown area." };
  if (!area.importPermission) {
    return { user, area, error: area.importRefusedBecause ?? "This area cannot be imported." };
  }
  if (!(await can(user.id, area.importPermission))) {
    return { user, area, error: `You can't import ${area.label.toLowerCase()}.` };
  }
  if (!IMPLEMENTED_IMPORTS.includes(areaKey)) {
    return { user, area, error: `Import for ${area.label.toLowerCase()} isn't built yet.` };
  }
  return { user, area, error: null };
}

export async function previewImport(input: {
  area: string;
  filename: string;
  base64: string;
}): Promise<ActionResult<ImportPlan>> {
  const { user, area, error } = await gate(input.area);
  if (error || !area) {
    if (error?.startsWith("You can't")) {
      await logActivity({
        kind: "PERMISSION_DENIED",
        severity: "WARNING",
        summary: `${user.name} tried to import ${input.area} without permission`,
      });
    }
    return { ok: false, error: error ?? "Unknown area." };
  }

  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) {
    return { ok: false, error: `That file is over ${MAX_BYTES / 1024 / 1024}MB. Split it and import in batches.` };
  }
  if (!/\.(csv|xlsx)$/i.test(input.filename)) {
    return { ok: false, error: "Use a .csv or .xlsx file." };
  }

  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };
    return { ok: true, data: await plan(input.area, rows, user.id) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? `Couldn't read that file: ${err.message}` : "Couldn't read that file." };
  }
}

export async function commitImport(input: {
  area: string;
  filename: string;
  base64: string;
}): Promise<ActionResult<{ created: number; updated: number; skipped: number; failed: { line: number; error: string }[] }>> {
  const { user, area, error } = await gate(input.area);
  if (error || !area) return { ok: false, error: error ?? "Unknown area." };

  try {
    const rows = await parseFile(input.base64, input.filename);
    if (rows.length === 0) return { ok: false, error: "That file has no rows." };

    const result = await apply(input.area, rows, user.id);

    const summary =
      `${user.name} imported ${area.label.toLowerCase()} from ${input.filename}: ` +
      `${result.created} created, ${result.updated} updated, ${result.skipped} unchanged` +
      (result.failed.length ? `, ${result.failed.length} failed` : "");

    // Both trails: the activity log is the security record of data entering the system, and the
    // audit log is where somebody looks when a record's history is in question.
    await logActivity({
      kind: "EXPORT",
      severity: result.failed.length ? "WARNING" : "NOTICE",
      summary,
      metadata: {
        direction: "import",
        area: input.area,
        file: input.filename,
        created: result.created,
        updated: result.updated,
        failed: result.failed.length,
      },
    });
    await recordAudit({
      userId: user.id,
      action: result.created > 0 ? "CREATE" : "UPDATE",
      entityType: "Import",
      entityId: input.area,
      entityLabel: summary,
    });

    revalidatePath("/", "layout");
    return { ok: true, data: result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Import failed." };
  }
}

/** A CSV with the right headings and nothing else — the fastest way to get the columns right. */
export async function importTemplate(areaKey: string): Promise<ActionResult<{ filename: string; csv: string }>> {
  const { area, error } = await gate(areaKey);
  if (error || !area) return { ok: false, error: error ?? "Unknown area." };
  const columns = TEMPLATE_COLUMNS[areaKey] ?? [];
  return { ok: true, data: { filename: `${areaKey}-import-template.csv`, csv: columns.join(",") + "\n" } };
}
