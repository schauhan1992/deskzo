import { redirect } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { callingReport } from "@/actions/call-report";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { TeamReport } from "@/components/calls/team-report";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Calls › Team report (owner, 18 Oct 2026): each person's calling in a period — how much, how much reached
 * somebody, when the day's calling starts and stops, what the Deskzo app logged, the callbacks owed and how
 * fast new leads were called. Within the viewer's own reach, as the Calls list is (src/actions/call-report.ts).
 */
export default async function CallsReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  if (!(await isModuleEnabled("calls"))) return <ModuleDisabledNotice moduleKey="calls" />;
  const params = await searchParams;
  // Today, said in the address — so the period picker shows the days the report is about, not "All time".
  if (!params.from && !params.to) {
    const today = (await workspaceClock()).today();
    redirect(`/calls/report?from=${today}&to=${today}`);
  }
  const report = await callingReport({ from: params.from, to: params.to });
  if (!report) return <ModuleDisabledNotice moduleKey="calls" />;
  return <TeamReport report={report} />;
}
