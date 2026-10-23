import { isModuleEnabled } from "@/actions/module";
import { reportingHome } from "@/actions/reporting";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ReportingOverview } from "@/components/reporting/overview";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Reporting & Analytics — the overview. Switched off means switched off, not merely unlinked: every page under
 * /reports reads thousands of rows, so each one checks the module itself (as the explorer always has).
 */
export default async function ReportsPage() {
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;
  const [home, clock] = await Promise.all([reportingHome(), workspaceClock()]);
  if (!home.ok) return <ModuleDisabledNotice moduleKey="reports" />;
  return <ReportingOverview home={home.data} today={clock.today()} />;
}
