import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { openReport } from "@/actions/reporting";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportBuilder } from "@/components/reporting/builder";
import { ReportUnavailable, SourceLocked } from "@/components/reporting/report-states";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The Report Builder for one saved report — for its owner and whoever it is shared with to edit. Somebody who may
 * only view it is sent to the viewer; the server refuses their saves either way (src/actions/reporting.ts).
 */
export default async function EditReportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const { id } = await params;
  const [opened, clock] = await Promise.all([openReport(id), workspaceClock()]);
  if (!opened.ok) return <ReportUnavailable message={opened.error} />;
  const report = opened.data;
  if (report.access === "view") redirect(`/reports/${report.id}`);
  if (!report.source.available) {
    return <SourceLocked reportId={report.id} reportName={report.name} sourceLabel={report.source.label} reason={report.source.lockedReason} owner={report.owner.name} own={report.access === "owner"} />;
  }
  return <ReportBuilder report={report} source={report.source} today={clock.today()} />;
}
