"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusDot, StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useClock } from "@/components/time/clock-provider";
import { SidePane } from "@/components/ui/side-pane";
import { plural } from "@/lib/console-shared/format";
import type { FailingJobSummary } from "@/lib/platform/health";
import { cn } from "@/lib/utils";

/**
 * "Scheduled jobs across workspaces" on System health (spec §3.11): every job workspaces run on a
 * schedule — backups, usage snapshots, the marketing heartbeat — with how many workspaces' last run of
 * it failed, failing first (the loader's order). A failing row opens a side pane with the most recent
 * failure's whole error and a link to each failing workspace's Operations tab.
 *
 * Errors arrive redacted from the loader; nothing here reads them in full until the pane opens.
 */

/** The first non-empty line of an error, for the table cell. */
function firstLine(text: string | null): string | null {
  const line = text
    ?.split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

export function FailingJobsTable({ rows }: { rows: FailingJobSummary[] }) {
  const clock = useClock();
  const [openJob, setOpenJob] = useState<FailingJobSummary | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<CalendarClock className="h-5 w-5" />}
        title="No workspace has run a scheduled job yet."
        body="Backups, usage snapshots and the marketing heartbeat record each run here once workspaces are in use."
      />
    );
  }

  return (
    <>
      <DataTable caption="Scheduled jobs across workspaces" minWidth={680}>
        <THead>
          <Th>Job</Th>
          <Th numeric>Workspaces failing</Th>
          <Th>Last error</Th>
          <Th>Most recent failure</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const failing = row.workspaces > 0;
            const line = firstLine(row.lastError);
            return (
              // A failing row is one button: the first cell's covers the row (its ::after), so a click anywhere opens the pane.
              <Tr key={row.job} className={cn(failing && "relative hover:bg-surface-sunken", openJob?.job === row.job && "bg-surface-sunken")}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <StatusDot tone={failing ? "danger" : "success"} label={failing ? "Failing" : "OK"} />
                    {failing ? (
                      <button
                        type="button"
                        onClick={() => setOpenJob(row)}
                        className="rounded-base text-left font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand"
                      >
                        {row.label}
                        <span className="sr-only">{`: show the last error and the ${plural(row.workspaces, "failing workspace")}`}</span>
                      </button>
                    ) : (
                      <span className="font-medium text-text">{row.label}</span>
                    )}
                  </div>
                </Td>
                <Td numeric>{failing ? <span className="font-medium text-danger">{row.workspaces.toLocaleString("en-IN")}</span> : <span className="text-subtle">0</span>}</Td>
                <Td muted>
                  {line ? <span className="block max-w-96 truncate font-mono text-xs text-danger">{line}</span> : <span className="text-subtle">—</span>}
                </Td>
                <Td nowrap muted>
                  {failing && row.lastAt ? <RelativeTime at={row.lastAt} /> : <span className="text-subtle">—</span>}
                </Td>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      <SidePane open={openJob !== null} onClose={() => setOpenJob(null)} title={openJob ? openJob.label : "Scheduled job"}>
        {openJob && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="danger" dot>
                {`Failing in ${plural(openJob.workspaces, "workspace")}`}
              </StatusPill>
              <span className="font-mono text-xs text-subtle">{openJob.job}</span>
            </div>

            <DefinitionList columns={1} items={[{ term: "Most recent failure", value: clock.dateTime(openJob.lastAt) }]} />

            <div>
              <h3 className="text-[13px] font-medium text-text">Last error</h3>
              {openJob.lastError ? (
                <>
                  <pre
                    tabIndex={0}
                    aria-label="Last error"
                    className="mt-1.5 max-h-[40vh] overflow-auto rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-danger"
                  >
                    {openJob.lastError}
                  </pre>
                  <p className="mt-1 text-[11px] text-subtle">From the most recent failure. Passwords and keys in it are masked.</p>
                </>
              ) : (
                <p className="mt-1 text-muted">No error text was recorded.</p>
              )}
            </div>

            <div>
              <h3 className="text-[13px] font-medium text-text">{`Failing workspaces (${openJob.slugs.length.toLocaleString("en-IN")})`}</h3>
              <ul className="mt-1.5 divide-y divide-line overflow-hidden rounded-lg border border-line">
                {openJob.slugs.map((slug) => (
                  <li key={slug}>
                    <Link
                      href={`/workspaces/${encodeURIComponent(slug)}?tab=operations`}
                      className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 truncate font-mono text-xs font-medium text-text">{slug}</span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-brand">
                        Operations
                        <ArrowRight aria-hidden="true" className="h-3 w-3" />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </SidePane>
    </>
  );
}
