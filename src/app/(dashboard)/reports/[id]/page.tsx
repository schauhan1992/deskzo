import { isModuleEnabled } from "@/actions/module";
import { openReport } from "@/actions/reporting";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportUnavailable, SourceLocked } from "@/components/reporting/report-states";
import { ReportViewer } from "@/components/reporting/viewer";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * A saved report, read — by its owner or anyone it is shared with, each seeing the rows their own role allows
 * (src/actions/reporting.ts openReport, runReport). Somebody it was shared with who can't open its source is told
 * so, and can ask its owner.
 */
export default async function ReportPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ share?: string }> }) {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const [{ id }, { share }] = await Promise.all([params, searchParams]);
  const [opened, clock] = await Promise.all([openReport(id), workspaceClock()]);
  if (!opened.ok) return <ReportUnavailable message={opened.error} />;
  const report = opened.data;
  if (!report.source.available) {
    return <SourceLocked reportId={report.id} reportName={report.name} sourceLabel={report.source.label} reason={report.source.lockedReason} owner={report.owner.name} own={report.access === "owner"} />;
  }
  return <ReportViewer report={report} source={report.source} today={clock.today()} openShare={share === "1" && report.access === "owner"} />;
}
