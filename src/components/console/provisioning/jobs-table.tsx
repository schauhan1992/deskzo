"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, RotateCcw } from "lucide-react";
import { consoleRetryJob } from "@/actions/platform/console";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { CopyButton } from "@/components/console/kit/copy-field";
import { DefinitionList } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu } from "@/components/console/kit/row-menu";
import { JobStatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { SidePane } from "@/components/ui/side-pane";
import { durationText, when } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { JobRow } from "@/lib/platform/console-data";

/**
 * The setups on the Provisioning board (spec §3.12), in the loader's order — failed first, then
 * running, waiting and done. A row opens its workspace; "Details" opens the job itself in a side pane:
 * the whole error, who signed up and what for, and when it runs next.
 *
 * Managers try a failed setup again (T1, `consoleRetryJob`); nobody else is shown the button. Errors
 * arrive redacted from the loader, and nothing here ever holds the owner's password or its hash.
 */

/** The first non-empty line of an error, for the table cell — the rest is in the pane. */
function firstLine(text: string | null): string | null {
  const line = text
    ?.split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

const workspaceHref = (slug: string, tab?: "operations") => `/workspaces/${encodeURIComponent(slug)}${tab ? `?tab=${tab}` : ""}`;
const attempts = (job: JobRow) => `${job.attempts} of ${job.maxAttempts}`;

/** How long the last attempt took — or has taken so far, while it runs. */
function took(job: JobRow): string {
  if (job.durationMs === null) return "—";
  return job.status === "RUNNING" ? `${durationText(job.durationMs)} so far` : durationText(job.durationMs);
}

export function JobsTable({ rows, caps }: { rows: JobRow[]; caps: Caps }) {
  const [detail, setDetail] = useState<JobRow | null>(null);
  const [retry, setRetry] = useState<JobRow | null>(null);
  const action = useConsoleAction<null>();

  // The board refreshes itself every few seconds while setups run: the pane follows the row as it
  // changes, and keeps the last state it saw once the row has moved off this page.
  const shown = detail ? (rows.find((r) => r.id === detail.id) ?? detail) : null;
  const canRetry = (job: JobRow) => caps.manage && job.status === "FAILED";

  function openRetry(job: JobRow) {
    action.reset();
    // One modal at a time: the confirmation replaces the pane rather than stacking over it.
    setDetail(null);
    setRetry(job);
  }

  function closeRetry() {
    if (action.pending) return;
    action.reset();
    setRetry(null);
  }

  function confirmRetry() {
    const job = retry;
    if (!job) return;
    action.run(() => consoleRetryJob(job.id), {
      success: `${job.tenant.name}'s setup is queued again — the worker has been started.`,
      onDone: () => setRetry(null),
    });
  }

  return (
    <>
      <DataTable caption="Workspace setups" minWidth={980}>
        <THead>
          <Th>Workspace</Th>
          <Th>Status</Th>
          <Th>Step</Th>
          <Th numeric>Attempts</Th>
          <Th>Queued</Th>
          <Th>Started</Th>
          <Th numeric>Duration</Th>
          <Th srOnly>Actions</Th>
        </THead>
        <TBody>
          {rows.map((job) => {
            const failed = job.status === "FAILED";
            const line = failed ? firstLine(job.error) : null;
            return (
              <Tr key={job.id} interactive>
                <Td>
                  <div className="max-w-[16rem] min-w-40">
                    <RowLink href={workspaceHref(job.tenant.slug)} className="block truncate">
                      {job.tenant.name}
                    </RowLink>
                    <p className="truncate font-mono text-[11px] text-subtle">{job.tenant.slug}</p>
                  </div>
                </Td>
                <Td nowrap>
                  <JobStatusPill status={job.status} />
                </Td>
                <Td>
                  <div className="max-w-xs min-w-48">
                    <p className="truncate text-text" title={job.step || undefined}>
                      {job.step || "—"}
                    </p>
                    {failed && (
                      <p className="mt-0.5 flex min-w-0 items-baseline gap-2 text-xs">
                        <span className="min-w-0 truncate font-mono text-danger" title={line ?? undefined}>
                          {line ?? "No error was recorded."}
                        </span>
                        <button type="button" onClick={() => setDetail(job)} className="shrink-0 rounded-base font-medium text-brand hover:underline">
                          Details
                          <span className="sr-only">{` of the setup of ${job.tenant.slug}`}</span>
                        </button>
                      </p>
                    )}
                  </div>
                </Td>
                <Td numeric muted={job.attempts === 0}>
                  {attempts(job)}
                </Td>
                <Td muted nowrap>
                  <RelativeTime at={job.createdAt} />
                </Td>
                <Td muted nowrap>
                  {job.startedAt ? <RelativeTime at={job.startedAt} /> : <span className="text-subtle">{job.status === "PENDING" ? "Not yet" : "—"}</span>}
                </Td>
                <Td numeric muted>
                  {took(job)}
                </Td>
                <RowActionsCell>
                  {canRetry(job) && (
                    <Button type="button" size="sm" variant="secondary" onClick={() => openRetry(job)} className="mr-1 h-7 px-2.5">
                      <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                      Try again
                      <span className="sr-only">{` the setup of ${job.tenant.slug}`}</span>
                    </Button>
                  )}
                  <RowMenu
                    label={`Actions for ${job.tenant.slug}`}
                    items={[
                      { key: "details", label: "Setup details", onSelect: () => setDetail(job) },
                      { key: "sep-open", separator: true },
                      { key: "open", label: "Open workspace", href: workspaceHref(job.tenant.slug) },
                      { key: "ops", label: "Open its Operations tab", href: workspaceHref(job.tenant.slug, "operations") },
                    ]}
                  />
                </RowActionsCell>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      <SidePane open={shown !== null} onClose={() => setDetail(null)} title={shown ? `Setup · ${shown.tenant.name}` : "Setup"}>
        {shown && <JobDetails job={shown} canRetry={canRetry(shown)} onRetry={() => openRetry(shown)} />}
      </SidePane>

      {caps.manage && (
        <ConfirmDialog
          open={retry !== null}
          onClose={closeRetry}
          title="Try setup again"
          confirmLabel="Try again"
          pending={action.pending}
          error={action.error}
          onConfirm={confirmRetry}
        >
          {retry && (
            <p>{`Puts the setup of ${retry.tenant.name} back in the queue with its attempts reset to 0 of ${retry.maxAttempts}, and starts the worker to take it.`}</p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}

/** The side pane's body: the error first (it is why anybody opens this), then the signup and the timings. */
function JobDetails({ job, canRetry, onRetry }: { job: JobRow; canRetry: boolean; onRetry: () => void }) {
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <JobStatusPill status={job.status} />
        <TenantStatusPill status={job.tenant.status} />
        <span className="text-xs text-muted tabular-nums">{`Attempt ${attempts(job)}`}</span>
      </div>

      {job.error ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-medium text-text">{job.status === "FAILED" ? "Error" : "Last error"}</h3>
            <CopyButton value={job.error} label="Copy the error" />
          </div>
          <pre
            tabIndex={0}
            aria-label="Error"
            className="mt-1.5 max-h-[40vh] overflow-auto rounded-lg border border-danger/40 bg-danger-bg px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-danger"
          >
            {job.error}
          </pre>
          <p className="mt-1 text-[11px] text-subtle">Passwords and keys in it are masked.</p>
        </div>
      ) : job.status === "FAILED" ? (
        <p className="text-muted">No error text was recorded.</p>
      ) : null}

      <DefinitionList
        items={[
          {
            term: "Workspace",
            value: (
              <Link href={workspaceHref(job.tenant.slug)} className="font-mono text-xs text-brand hover:underline">
                {job.tenant.slug}
              </Link>
            ),
          },
          { term: "Company", value: job.companyName || "—" },
          { term: "Owner", value: job.ownerName || "—" },
          { term: "Owner's email", value: <span className="break-all">{job.ownerEmail || "—"}</span> },
          { term: "Country", value: job.country || "—" },
          { term: "Plan", value: job.planKey ? <span className="font-mono text-xs">{job.planKey}</span> : "The default plan" },
          { term: "Step", value: job.step || "—", wide: true },
          { term: "Queued", value: when(job.createdAt) },
          { term: "Run after", value: when(job.runAfter) },
          { term: "Started", value: when(job.startedAt) },
          { term: "Finished", value: when(job.finishedAt) },
          { term: "Took", value: took(job) },
          { term: "Attempts", value: attempts(job) },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        {canRetry && (
          <Button type="button" size="sm" onClick={onRetry}>
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
            Try again
          </Button>
        )}
        <Link href={workspaceHref(job.tenant.slug, "operations")} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
          Open its Operations tab
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
