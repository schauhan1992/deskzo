import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { reportOptions } from "@/actions/analytics";
import { workbookFilterOptions } from "@/actions/workspace";
import { ReportExplorer } from "@/components/reports/report-explorer";
import { workspaceClock } from "@/lib/time/workspace";

export default async function ReportsPage() {
  /**
   * Switched off means switched off, not merely unlinked.
   *
   * The Reports module took the nav entry out of the sidebar and left the route serving, so `/reports`
   * answered by URL for anybody who had it bookmarked or had been sent the link — and this is the one
   * page whose whole purpose is to read thousands of rows at once. Every other dashboard route that
   * belongs to a module says so; this one did not, and nothing pointed at the gap because the link
   * really had disappeared.
   */
  if (!(await isModuleEnabled("reports"))) return <ModuleDisabledNotice moduleKey="reports" />;

  const [{ sources, grains }, filterOptions, clock] = await Promise.all([reportOptions(), workbookFilterOptions(), workspaceClock()]);

  // The clock is read here rather than in the explorer: a client component that reads it during
  // render is non-deterministic, and the React compiler refuses it outright.
  const now = new Date();

  return (
    <div>
      <h1 className="text-xl font-semibold text-text">Reports</h1>
      <p className="mt-1 text-sm text-muted">
        Any number, broken down by anything. Pick what to report on, which figure you want, and what to split it by —
        every combination works, so there is nothing to request and nothing to wait for.
      </p>

      <ReportExplorer
        sources={sources}
        grains={grains}
        filterOptions={filterOptions}
        // The workspace's date and month, not the server's: in UTC those can still be yesterday's.
        today={clock.today(now)}
        monthStart={`${clock.monthKey(now)}-01`}
      />
    </div>
  );
}
