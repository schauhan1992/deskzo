import type { ReactNode } from "react";
import type { Metadata } from "next";
import { Activity, CircleOff, Fingerprint, Moon, TriangleAlert } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SearchField, SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, FilterChips } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { TerminalsTable } from "@/components/console/terminals/terminals-table";
import { Pagination } from "@/components/ui/pagination";
import { percent } from "@/lib/console-shared/format";
import { TERMINAL_STATE } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { TERMINAL_STATES, parseTerminalFilters, withParams, type TerminalState } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { terminals } from "@/lib/platform/console-data";
import { consoleStaff } from "@/lib/platform/console-page";

export const metadata: Metadata = { title: "Terminals" };

const PATH = "/devices";
const num = (n: number) => n.toLocaleString("en-IN");

/** What each state means, under its tile — the loader's thresholds (console-data `terminalState`). */
const STATE_TILES: Record<TerminalState, { secondary: string; icon: ReactNode }> = {
  live: { secondary: "Heard from in the last 24 hours", icon: <Activity className="h-4 w-4" /> },
  quiet: { secondary: "Last heard 1 to 7 days ago", icon: <Moon className="h-4 w-4" /> },
  stale: { secondary: "Silent for more than 7 days", icon: <TriangleAlert className="h-4 w-4" /> },
  never: { secondary: "Not heard from since it was routed", icon: <CircleOff className="h-4 w-4" /> },
};

/**
 * Terminals (spec §3.14): the attendance terminals that report to this platform, by serial number,
 * and the workspace each one's punches are routed to. A terminal that calls in without a workspace's
 * address is routed by its serial, and a serial belongs to one workspace at a time; releasing it (for
 * managers) frees it to be registered by another — when a terminal changes hands.
 *
 * The folder stays `devices` (the check suites load it by that path); the page is "Terminals".
 */
export default async function ConsoleDevicesPage({ searchParams }: PageProps<"/platform-console/devices">) {
  const staff = await consoleStaff(PAGE_ROLES.devices);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseTerminalFilters(sp);
  const data = await terminals(f);
  const c = data.counts;

  const narrowed = Boolean(f.q || f.tenant || f.state);
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const chips = [
    ...(f.tenant ? [{ key: "tenant", label: `Workspace: ${f.tenant}`, removeHref: withParams(PATH, sp, { tenant: null }) }] : []),
    ...(f.state ? [{ key: "state", label: `State: ${TERMINAL_STATE[f.state].label}`, removeHref: withParams(PATH, sp, { state: null }) }] : []),
    ...(f.q ? [{ key: "q", label: `Search: ${f.q}`, removeHref: withParams(PATH, sp, { q: null }) }] : []),
  ];
  // Counts follow the search and the workspace, not the state — so the tiles add up to the total.
  const scope = f.q || f.tenant ? " matching" : "";

  return (
    <>
      <PageHeader title="Terminals" subtitle="Attendance terminals routed by serial number" />

      <div className="space-y-6">
        <KpiGrid columns={5}>
          <KpiTile
            label={`Total${scope}`}
            value={num(c.total)}
            icon={<Fingerprint className="h-4 w-4" />}
            href={withParams(PATH, sp, { state: null })}
            secondary={c.total > 0 ? `${percent(c.live, c.total)} reported in the last 24 hours` : "None routed yet"}
          />
          {TERMINAL_STATES.map((state) => (
            <KpiTile
              key={state}
              label={TERMINAL_STATE[state].label}
              value={num(c[state])}
              icon={STATE_TILES[state].icon}
              href={withParams(PATH, sp, { state })}
              tone={state === "stale" && c.stale > 0 ? "warning" : state === "live" && c.live > 0 ? "success" : "neutral"}
              secondary={STATE_TILES[state].secondary}
            />
          ))}
        </KpiGrid>

        <section aria-label="Terminals">
          {(c.total > 0 || narrowed) && (
            <>
              <FilterBar>
                <SearchField label="Search terminals" placeholder="Serial, workspace name or slug" />
                <SelectFilter
                  param="state"
                  label="State"
                  allLabel="Any state"
                  options={TERMINAL_STATES.map((state) => ({ value: state, label: TERMINAL_STATE[state].label }))}
                />
              </FilterBar>
              <FilterChips chips={chips} clearHref={chips.length > 1 ? PATH : undefined} />
            </>
          )}

          {data.rows.length > 0 ? (
            <>
              <Panel padded={false}>
                <TerminalsTable rows={data.rows} caps={caps} />
              </Panel>
              {totalPages > 1 && (
                <Pagination page={data.page} pageSize={data.pageSize} total={data.total} totalPages={totalPages} pageSizes={[data.pageSize]} label="terminals" />
              )}
            </>
          ) : (
            <Panel padded={false}>
              {narrowed ? (
                <EmptyState
                  variant="filtered"
                  title="No terminal matches."
                  body="Search by the start of a serial, or by a workspace's name or slug."
                  clearHref={PATH}
                />
              ) : (
                <EmptyState
                  icon={<Fingerprint className="h-5 w-5" />}
                  title="No terminals are routed yet."
                  body="Workspaces register them from their attendance settings."
                />
              )}
            </Panel>
          )}
        </section>
      </div>
    </>
  );
}
