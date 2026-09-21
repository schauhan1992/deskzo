"use server";

import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { getArea, PORTABLE_AREAS } from "@/lib/portability/areas";
import { IMPLEMENTED_IMPORTS } from "@/lib/portability/import";
import { areaRows, accountBundle, toWorkbookBuffer, toCsv } from "@/lib/portability/export";
import type { ActionResult } from "@/actions/company";

/**
 * Taking data out.
 *
 * Three gates, in this order, and each answers a different question:
 *
 *   1. **May this person export this area at all?** The permission from the area registry.
 *   2. **Which rows?** Whatever the account scoping already gives them. An export is never a way to
 *      see more than the screen shows.
 *   3. **How many?** The DLP row cap. A thousand rows is a report; fifty thousand is a copy of the
 *      business, and the difference is worth a deliberate decision.
 *
 * Every export is logged whether it succeeds or is refused. Downloading customer data is the most
 * ordinary way information leaves a company, so the record of who took what is the point rather
 * than an afterthought.
 */

/** The base64 wrapper exists because a server action cannot stream a file; the client rebuilds it. */
export type ExportPayload = {
  filename: string;
  /** "text/csv" or the spreadsheet type. */
  contentType: string;
  base64: string;
  rows: number;
};

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** What the current user may export, for rendering the screen. */
export async function exportableAreas() {
  const user = await requireUser();
  const allowed = await Promise.all(
    PORTABLE_AREAS.map(async (a) => ({
      key: a.key,
      label: a.label,
      description: a.description,
      canExport: await can(user.id, a.exportPermission),
      canImport: a.importPermission ? await can(user.id, a.importPermission) : false,
      importRefusedBecause: a.importRefusedBecause ?? null,
      importable: a.importPermission !== null,
      // A permission without an importer behind it would be a button that refuses on click.
      importBuilt: IMPLEMENTED_IMPORTS.includes(a.key),
    })),
  );
  return allowed;
}

export async function exportArea(areaKey: string, format: "csv" | "xlsx" = "xlsx"): Promise<ActionResult<ExportPayload>> {
  const user = await requireUser();
  const area = getArea(areaKey);
  if (!area) return { ok: false, error: "Unknown area." };

  if (!(await can(user.id, area.exportPermission))) {
    // Logged, because a refused export is more interesting than a successful one.
    await logActivity({
      kind: "PERMISSION_DENIED",
      severity: "WARNING",
      summary: `${user.name} tried to export ${area.label} without permission`,
      metadata: { area: areaKey },
    });
    return { ok: false, error: `You can't export ${area.label.toLowerCase()}.` };
  }

  const rows = await areaRows(user.id, areaKey);

  const policy = await getSecurityPolicy();
  const verdict = exportDecision(rows.length, policy);
  if (!verdict.allowed) {
    await logActivity({
      kind: "EXPORT",
      severity: "WARNING",
      summary: `${user.name} was refused an export of ${rows.length.toLocaleString("en-IN")} ${area.label.toLowerCase()} rows — over the limit`,
      metadata: { area: areaKey, rows: rows.length, limit: policy.exportRowLimit },
    });
    return { ok: false, error: verdict.reason };
  }

  const filename = `${areaKey}-${stamp()}`;
  const payload: ExportPayload =
    format === "csv"
      ? {
          filename: `${filename}.csv`,
          contentType: "text/csv;charset=utf-8",
          base64: Buffer.from(toCsv(rows), "utf8").toString("base64"),
          rows: rows.length,
        }
      : {
          filename: `${filename}.xlsx`,
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64: (
            await toWorkbookBuffer([{ name: area.label, rows }], {
              title: area.label,
              by: `${user.name} <${user.email}>`,
              generatedAt: new Date(),
            })
          ).toString("base64"),
          rows: rows.length,
        };

  await logActivity({
    kind: "EXPORT",
    severity: "NOTICE",
    summary: `${user.name} exported ${rows.length.toLocaleString("en-IN")} ${area.label.toLowerCase()} rows`,
    metadata: { area: areaKey, rows: rows.length, format },
  });

  return { ok: true, data: payload };
}

/**
 * One account and everything hanging off it, as a multi-sheet workbook.
 *
 * The sheets are the relationships — contacts, orders, payments, leads, tickets, visits, documents.
 * Flattening them into one would repeat the company on every row and lose which record belongs to
 * which relationship, which is the opposite of what somebody asking for "everything about this
 * customer" wants.
 */
export async function exportAccount(companyId: string): Promise<ActionResult<ExportPayload>> {
  const user = await requireUser();

  if (!(await can(user.id, "data.exportCrm"))) {
    await logActivity({
      kind: "PERMISSION_DENIED",
      severity: "WARNING",
      summary: `${user.name} tried to export a customer record without permission`,
      entityType: "Company",
      entityId: companyId,
    });
    return { ok: false, error: "You can't export customer data." };
  }

  const bundle = await accountBundle(user.id, companyId);
  // Null means it does not exist *or* is not theirs. Saying which would itself disclose something.
  if (!bundle) return { ok: false, error: "That account isn't available to you." };

  const total = bundle.sheets.reduce((n, s) => n + s.rows.length, 0);
  const buffer = await toWorkbookBuffer(bundle.sheets, {
    title: `${bundle.company.name} — complete record`,
    by: `${user.name} <${user.email}>`,
    generatedAt: new Date(),
  });

  await logActivity({
    kind: "EXPORT",
    severity: "NOTICE",
    summary: `${user.name} exported the complete record for ${bundle.company.name} (${total} rows across ${bundle.sheets.length} sheets)`,
    entityType: "Company",
    entityId: companyId,
    metadata: { rows: total, sheets: bundle.sheets.map((s) => `${s.name}:${s.rows.length}`) },
  });

  return {
    ok: true,
    data: {
      filename: `${bundle.company.normalizedName.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}-${stamp()}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buffer.toString("base64"),
      rows: total,
    },
  };
}
