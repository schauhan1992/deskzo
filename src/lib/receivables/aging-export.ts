import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { getSecurityPolicy } from "@/lib/security/store";
import { exportDecision } from "@/lib/security/policy";
import { toWorkbookBuffer } from "@/lib/portability/export";
import { formatCalendarDay } from "@/lib/time/zone";
import { agingReportFor, agingSheets, intervalLabel, type AgingParams, type AgingSide } from "@/lib/receivables/aging";
import type { ActionResult } from "@/actions/company";
import type { ExportPayload } from "@/actions/data-export";

/**
 * The aging report as a workbook — the summary on one sheet, every invoice or bill behind it on the next —
 * through the gates every finance download has (src/actions/data-export.ts): the finance export permission,
 * the workspace's row limit, and a line in the activity log either way. Only what the screen shows: the
 * same report, for the same person, with the same settings.
 */
export async function exportAging(user: { id: string; name: string | null; email: string }, side: AgingSide, params?: AgingParams): Promise<ActionResult<ExportPayload>> {
  const what = side === "AR" ? "receivables aging" : "payables aging";
  if (!(await can(user.id, "data.exportFinance"))) {
    await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} tried to download the ${what} without the export permission`, metadata: { report: what } });
    return { ok: false, error: "You can read this report but not download it. Downloading financial data needs the export permission." };
  }
  // The details view's narrowing is the screen's, not the file's: the file holds every document.
  const report = await agingReportFor(user.id, side, { ...params, party: undefined, col: undefined, docs: "1" });
  const policy = await getSecurityPolicy();
  const verdict = exportDecision(report.documents.length, policy);
  if (!verdict.allowed) {
    await logActivity({
      kind: "EXPORT",
      severity: "WARNING",
      summary: `${user.name} was refused a download of the ${what} — ${report.documents.length.toLocaleString("en-IN")} documents, over the limit`,
      metadata: { report: what, rows: report.documents.length, limit: policy.exportRowLimit },
    });
    return { ok: false, error: verdict.reason };
  }
  const s = report.settings;
  const title = `${side === "AR" ? "Receivables" : "Payables"} aging as of ${formatCalendarDay(s.asOf)} — by ${s.basis === "due" ? "due date" : side === "AR" ? "invoice date" : "bill date"}, ${intervalLabel(s.interval)}${s.search ? `, matching "${s.search}"` : ""}`;
  const buffer = await toWorkbookBuffer(agingSheets(report), { title, by: `${user.name} <${user.email}>`, generatedAt: new Date() });
  await logActivity({
    kind: "EXPORT",
    severity: "NOTICE",
    summary: `${user.name} downloaded the ${what} as of ${formatCalendarDay(s.asOf)} — ${report.rows.length} ${side === "AR" ? "customer" : "vendor"}(s), ${report.documents.length} document(s)`,
    metadata: { report: what, asOf: s.asOf, basis: s.basis, interval: s.interval, parties: report.rows.length, rows: report.documents.length },
  });
  return {
    ok: true,
    data: {
      filename: `${side === "AR" ? "receivables" : "payables"}-aging-${s.asOf}.xlsx`,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: buffer.toString("base64"),
      rows: report.documents.length,
    },
  };
}
