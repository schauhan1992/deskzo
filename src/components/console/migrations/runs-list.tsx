"use client";

import { Fragment, useId, useState } from "react";
import Link from "next/link";
import { ChevronRight, LoaderCircle, ScrollText } from "lucide-react";
import { CopyButton } from "@/components/console/kit/copy-field";
import { DefinitionList } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { SidePane } from "@/components/ui/side-pane";
import { durationText, plural } from "@/lib/console-shared/format";
import { runOutcome, schemaLabel } from "@/lib/console-shared/labels";
import type { RunGroup } from "@/lib/platform/console-data";
import { cn } from "@/lib/utils";

/**
 * Migration runs (spec §3.13), one row per run — a full `npm run tenants:migrate`, or one workspace
 * migrated from the console — newest first. A run opens to the databases it covered, in the order it
 * went through them, each with its outcome and its output (redacted, the last lines only) in a side
 * pane. The newest run starts open when it failed or is still going: that is the one being looked at.
 */

type RunRow = RunGroup["rows"][number];

/** What the script calls the one command that migrates everything; shown as code, not a person. */
const SCRIPT = "npm run tenants:migrate";
const COLUMNS = 8;

/** A run's outcome: running while any database is, failed when any did, otherwise done. */
const groupOutcome = (run: RunGroup) => runOutcome(run.running > 0 ? null : run.failed > 0 ? false : true);

/** "control" and "reference" are the platform's own databases, "warm:w_…" a database in the warm pool, anything else a workspace. */
function Target({ target }: { target: string }) {
  if (target === "control") return <TargetName name="Control plane" raw={target} />;
  if (target === "reference") return <TargetName name="Reference data" raw={target} />;
  if (target.startsWith("warm:")) return <TargetName name="Warm database" raw={target.slice(5)} />;
  return (
    <Link href={`/workspaces/${encodeURIComponent(target)}`} className="rounded-base font-mono text-xs font-medium text-brand hover:underline">
      {target}
    </Link>
  );
}

function TargetName({ name, raw }: { name: string; raw: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-medium text-text">{name}</span>
      <span className="font-mono text-[11px] text-subtle">{raw}</span>
    </span>
  );
}

function targetText(target: string): string {
  if (target === "control") return "Control plane";
  if (target === "reference") return "Reference data";
  if (target.startsWith("warm:")) return `Warm database ${target.slice(5)}`;
  return target;
}

function Outcome({ ok }: { ok: boolean | null }) {
  const o = runOutcome(ok);
  return (
    <StatusPill tone={o.tone} icon={ok === null ? <LoaderCircle className="h-3 w-3 animate-spin" /> : undefined}>
      {o.label}
    </StatusPill>
  );
}

/** The last line a failed migration wrote — usually the reason. */
function lastLine(output: string | null): string | null {
  const lines = output
    ?.split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines?.[lines.length - 1];
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function Starter({ by }: { by: string | null }) {
  if (by === null) return <span className="text-subtle">Not yet known</span>;
  if (by === SCRIPT) return <code className="rounded-base bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] text-muted">{SCRIPT}</code>;
  return <span className="text-text">{by}</span>;
}

export function RunsList({ runs }: { runs: RunGroup[] }) {
  const idBase = useId();
  // The newest run starts open when it failed or is still going — it is what somebody came to see.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => {
    const newest = runs[0];
    return new Set(newest && (newest.failed > 0 || newest.running > 0) ? [newest.runId] : []);
  });
  const [output, setOutput] = useState<{ run: RunGroup; row: RunRow } | null>(null);

  // The page refreshes itself while a run is going: the pane follows the row it shows as it finishes.
  const shownRun = output ? (runs.find((r) => r.runId === output.run.runId) ?? output.run) : null;
  const shownRow = output && shownRun ? (shownRun.rows.find((r) => r.id === output.row.id) ?? output.row) : null;

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  return (
    <>
      <DataTable caption="Migration runs" minWidth={900}>
        <THead>
          <Th>Started</Th>
          <Th>Started by</Th>
          <Th numeric>Databases</Th>
          <Th numeric>Done</Th>
          <Th numeric>Failed</Th>
          <Th numeric>Duration</Th>
          <Th>Outcome</Th>
          <Th>Run</Th>
        </THead>
        <TBody>
          {runs.map((run, index) => {
            const open = expanded.has(run.runId);
            const detailId = `${idBase}-run-${index}`;
            const outcome = groupOutcome(run);
            return (
              <Fragment key={run.runId}>
                {/* The whole row toggles: the first cell's button covers it (its ::after). */}
                <Tr className={cn("relative hover:bg-surface-sunken", open && "bg-surface-sunken")}>
                  <Td nowrap>
                    <button
                      type="button"
                      onClick={() => toggle(run.runId)}
                      aria-expanded={open}
                      aria-controls={open ? detailId : undefined}
                      className="inline-flex items-center gap-1.5 rounded-base text-left font-medium text-text after:absolute after:inset-0 after:content-[''] hover:text-brand"
                    >
                      <ChevronRight aria-hidden="true" className={cn("h-4 w-4 shrink-0 text-subtle transition-transform", open && "rotate-90")} />
                      <RelativeTime at={run.startedAt} />
                      <span className="sr-only">{`: ${open ? "hide" : "show"} its ${plural(run.targets, "database")}`}</span>
                    </button>
                  </Td>
                  <Td nowrap>
                    <Starter by={run.by} />
                  </Td>
                  <Td numeric>{run.targets.toLocaleString("en-IN")}</Td>
                  <Td numeric muted={run.ok === 0}>
                    {run.ok.toLocaleString("en-IN")}
                  </Td>
                  <Td numeric>
                    {run.failed > 0 ? <span className="font-medium text-danger">{run.failed.toLocaleString("en-IN")}</span> : <span className="text-subtle">0</span>}
                  </Td>
                  <Td numeric muted>
                    {run.running > 0 ? `${run.running.toLocaleString("en-IN")} running` : durationText(run.durationMs)}
                  </Td>
                  <Td nowrap>
                    <StatusPill tone={outcome.tone} icon={run.running > 0 ? <LoaderCircle className="h-3 w-3 animate-spin" /> : undefined}>
                      {outcome.label}
                    </StatusPill>
                  </Td>
                  <Td mono muted nowrap>
                    <span title={run.runId}>{run.runId.slice(0, 8)}</span>
                  </Td>
                </Tr>
                {open && (
                  <tr id={detailId}>
                    <td colSpan={COLUMNS} className="bg-surface-sunken px-5 pt-1 pb-4">
                      <RunDetail run={run} onOutput={(row) => setOutput({ run, row })} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </TBody>
      </DataTable>

      <SidePane open={shownRow !== null} onClose={() => setOutput(null)} title={shownRow ? `Output · ${targetText(shownRow.target)}` : "Output"}>
        {shownRun && shownRow && <OutputPane run={shownRun} row={shownRow} />}
      </SidePane>
    </>
  );
}

/** The databases one run covered, in the order it went through them. */
function RunDetail({ run, onOutput }: { run: RunGroup; onOutput: (row: RunRow) => void }) {
  return (
    <div className="space-y-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>{`${plural(run.targets, "database")} in the order the run took them`}</span>
        <span aria-hidden="true">·</span>
        <span className="inline-flex items-center gap-0.5">
          Run <span className="font-mono text-text">{run.runId}</span>
          <CopyButton value={run.runId} label="Copy the run id" />
        </span>
      </p>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <DataTable caption={`Databases in run ${run.runId.slice(0, 8)}`} minWidth={760}>
          <THead>
            <Th>Database</Th>
            <Th>From → to</Th>
            <Th>Outcome</Th>
            <Th numeric>Duration</Th>
            <Th srOnly>Output</Th>
          </THead>
          <TBody>
            {run.rows.map((row) => {
              const reason = row.ok === false ? lastLine(row.output) : null;
              const hasOutput = Boolean(row.output?.trim());
              return (
                <Tr key={row.id}>
                  <Td>
                    <Target target={row.target} />
                    {reason && (
                      <p className="mt-0.5 max-w-md truncate font-mono text-xs text-danger" title={reason}>
                        {reason}
                      </p>
                    )}
                  </Td>
                  <Td nowrap>
                    <span title={row.fromVersion ?? undefined} className={row.fromVersion ? undefined : "text-subtle"}>
                      {row.fromVersion ? schemaLabel(row.fromVersion) : "—"}
                    </span>
                    <span aria-hidden="true" className="mx-1.5 text-subtle">
                      →
                    </span>
                    <span className="sr-only"> to </span>
                    <span title={row.toVersion ?? undefined}>{schemaLabel(row.toVersion)}</span>
                  </Td>
                  <Td nowrap>
                    <Outcome ok={row.ok} />
                  </Td>
                  <Td numeric muted>
                    {row.finishedAt ? durationText(row.finishedAt.getTime() - row.startedAt.getTime()) : "—"}
                  </Td>
                  <Td nowrap className="w-px text-right">
                    {hasOutput ? (
                      <Button type="button" size="sm" variant="ghost" onClick={() => onOutput(row)} aria-haspopup="dialog" className="h-7 px-2">
                        <ScrollText aria-hidden="true" className="h-3.5 w-3.5" />
                        View output
                        <span className="sr-only">{` of ${targetText(row.target)}`}</span>
                      </Button>
                    ) : (
                      <span className="text-xs text-subtle">{row.ok === null ? "Running" : "No output"}</span>
                    )}
                  </Td>
                </Tr>
              );
            })}
          </TBody>
        </DataTable>
      </div>
    </div>
  );
}

function OutputPane({ run, row }: { run: RunGroup; row: RunRow }) {
  const clock = useClock();
  const text = row.output?.trimEnd() ?? "";
  const lines = text ? text.split("\n").length : 0;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Outcome ok={row.ok} />
        <span className="text-xs text-muted">{targetText(row.target)}</span>
      </div>
      <DefinitionList
        items={[
          { term: "Started", value: clock.dateTime(row.startedAt) },
          { term: "Took", value: row.finishedAt ? durationText(row.finishedAt.getTime() - row.startedAt.getTime()) : "Still running" },
          { term: "From", value: <span title={row.fromVersion ?? undefined}>{row.fromVersion ? schemaLabel(row.fromVersion) : "—"}</span> },
          { term: "To", value: <span title={row.toVersion ?? undefined}>{schemaLabel(row.toVersion)}</span> },
          { term: "Run", value: <span className="font-mono text-xs break-all">{run.runId}</span>, wide: true },
        ]}
      />
      {text ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-medium text-text">Output</h3>
            <span className="inline-flex items-center gap-1 text-xs text-muted">
              {`${plural(lines, "line")} · secrets masked`}
              <CopyButton value={text} label="Copy the output" />
            </span>
          </div>
          <pre
            tabIndex={0}
            aria-label="Migration output"
            className={cn(
              "mt-1.5 max-h-[60vh] overflow-auto rounded-lg border px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap",
              row.ok === false ? "border-danger/40 bg-danger-bg text-danger" : "border-line bg-surface-sunken text-text",
            )}
          >
            {text}
          </pre>
          <p className="mt-1 text-[11px] text-subtle">The last lines it wrote. Passwords and keys in it are masked.</p>
        </div>
      ) : (
        <p className="text-muted">No output was recorded.</p>
      )}
    </div>
  );
}
