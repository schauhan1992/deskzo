import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, Clock, Cpu, DatabaseZap, Globe, Rocket } from "lucide-react";
import { consoleReleaseDevice, consoleRetryJob } from "@/actions/platform/console";
import { ActionButton } from "@/components/console/kit/action-button";
import { CopyField } from "@/components/console/kit/copy-field";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { JobStatusPill, SchemaPill, StatusDot, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { durationText } from "@/lib/console-shared/format";
import { TERMINAL_STATE, leaseOutcome, runOutcome, schemaLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import type { TenantStatusKey } from "@/lib/console-shared/types";
import type { OpsPanel } from "@/lib/platform/workspace-data";
import { OutputPaneButton, ProbeDatabase, ReapplyLimitsButton } from "./ops-actions";

/**
 * Workspace 360 › Operations: how it was set up, the migrations run on its database, the scheduled
 * jobs that work on it, its terminals and domains, and its database.
 *
 * Everything here is read by every role; managers retry a failed setup, release a terminal, check
 * the database (on a click — never when the page loads) and put its role's limits back. A closed
 * workspace keeps the history and loses the controls.
 */

/** The first line of an error, for a table cell — the rest is one click away. */
const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? text;

/** An error that may run to many lines: its first line, and the whole of it on request. */
function ErrorDetails({ error }: { error: string }) {
  const head = firstLine(error);
  const more = error.trim() !== head;
  if (!more) return <span className="block max-w-sm break-words text-danger">{head}</span>;
  return (
    <details className="group max-w-sm">
      <summary className="flex cursor-pointer list-none items-start gap-1 rounded-base text-danger [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 break-words">{head}</span>
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-surface-sunken p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-text">
        {error}
      </pre>
    </details>
  );
}

function SeeAll({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
      {children}
      <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
    </Link>
  );
}

export function OpsTab({ ops, tenant, caps }: { ops: OpsPanel; tenant: { id: string; slug: string; status?: TenantStatusKey }; caps: Caps }) {
  const closed = tenant.status === "DEPROVISIONED";
  const manage = caps.manage && !closed;
  const slugParam = encodeURIComponent(tenant.slug);
  const db = ops.database;
  const hasDatabase = !!db.dbName && !!db.dbRole;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          title="Database"
          description="Where its data lives, and how current its schema is."
          className="lg:col-span-2"
          actions={manage && db.dbRole ? <ReapplyLimitsButton tenantId={tenant.id} /> : undefined}
        >
          <div className="space-y-4">
            <DefinitionList
              columns={3}
              items={[
                { term: "Database", value: db.dbName ? <span className="font-mono text-xs break-all">{db.dbName}</span> : <span className="text-muted">The installation&apos;s own</span> },
                { term: "Role", value: db.dbRole ? <span className="font-mono text-xs break-all">{db.dbRole}</span> : <span className="text-muted">—</span> },
                { term: "Region", value: db.region },
                {
                  term: "Schema",
                  value: (
                    <span className="flex flex-wrap items-center gap-2">
                      <span title={db.schemaVersion ?? undefined}>{schemaLabel(db.schemaVersion)}</span>
                      <SchemaPill version={db.schemaVersion} latest={db.latest} behindBy={db.behindBy} />
                    </span>
                  ),
                },
                { term: "Latest this code carries", value: <span title={db.latest ?? undefined}>{schemaLabel(db.latest)}</span> },
                { term: "Behind by", value: db.behindBy === null ? "—" : db.behindBy === 0 ? "Nothing" : `${db.behindBy} migration${db.behindBy === 1 ? "" : "s"}` },
              ]}
            />
            {manage && hasDatabase && (
              <div className="border-t border-line pt-4">
                <ProbeDatabase tenantId={tenant.id} />
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Domains" description="Addresses besides its own subdomain." padded={ops.domains.length === 0}>
          {ops.domains.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
              Reached at its own subdomain only.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {ops.domains.map((d) => (
                <li key={d.host} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5">
                  <span className="min-w-0 font-mono text-xs break-all text-text">{d.host}</span>
                  <span className="flex items-center gap-1.5">
                    {d.isPrimary && <StatusPill tone="brand">Primary</StatusPill>}
                    <StatusPill tone="neutral">{d.kind === "CUSTOM" ? "Custom" : "Legacy"}</StatusPill>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Setup" description="Its provisioning jobs, newest first." actions={<SeeAll href={`/provisioning?q=${slugParam}`}>Provisioning</SeeAll>} padded={false}>
        {ops.jobs.length === 0 ? (
          <EmptyState icon={<Rocket className="h-5 w-5" />} title="No setup jobs" body="It was set up before the provisioning queue kept jobs, or its jobs were cleared." />
        ) : (
          <DataTable caption="Provisioning jobs" minWidth={820}>
            <THead>
              <Th>Queued</Th>
              <Th>Status</Th>
              <Th>Step</Th>
              <Th numeric>Attempts</Th>
              <Th numeric>Took</Th>
              <Th>Error</Th>
              {manage && <Th srOnly>Try again</Th>}
            </THead>
            <TBody>
              {ops.jobs.map((job) => (
                <Tr key={job.id}>
                  <Td muted nowrap>
                    <RelativeTime at={job.createdAt} />
                  </Td>
                  <Td>
                    <JobStatusPill status={job.status} />
                  </Td>
                  <Td className="max-w-xs break-words">{job.step || "—"}</Td>
                  <Td numeric>{job.attempts}</Td>
                  <Td numeric muted>
                    {job.startedAt && job.finishedAt ? durationText(job.finishedAt.getTime() - job.startedAt.getTime()) : "—"}
                  </Td>
                  <Td>{job.error ? <ErrorDetails error={job.error} /> : <span className="text-muted">—</span>}</Td>
                  {manage && (
                    <RowActionsCell>
                      {job.status === "FAILED" ? (
                        <ActionButton
                          action={consoleRetryJob.bind(null, job.id)}
                          label="Try again"
                          confirm={{ title: "Try setup again", body: "Queues its setup again from the first step, and starts the worker.", confirmLabel: "Try again" }}
                          success="Setup queued again."
                        />
                      ) : null}
                    </RowActionsCell>
                  )}
                </Tr>
              ))}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Migrations" description="Runs of the workspace migrations on its database, newest first." actions={<SeeAll href={`/migrations?q=${slugParam}`}>Migrations</SeeAll>} padded={false}>
        {ops.migrations.length === 0 ? (
          <EmptyState icon={<DatabaseZap className="h-5 w-5" />} title="No migration runs" body="None has been recorded for its database." />
        ) : (
          <DataTable caption="Migration runs" minWidth={780}>
            <THead>
              <Th>Started</Th>
              <Th>From → to</Th>
              <Th>Outcome</Th>
              <Th numeric>Took</Th>
              <Th srOnly>Output</Th>
            </THead>
            <TBody>
              {ops.migrations.map((m) => {
                const outcome = runOutcome(m.ok);
                return (
                  <Tr key={m.id}>
                    <Td muted nowrap>
                      <RelativeTime at={m.startedAt} />
                    </Td>
                    <Td>
                      <span title={m.fromVersion ?? undefined}>{schemaLabel(m.fromVersion)}</span>
                      <span aria-hidden="true" className="mx-1.5 text-subtle">
                        →
                      </span>
                      <span className="sr-only"> to </span>
                      <span title={m.toVersion ?? undefined}>{schemaLabel(m.toVersion)}</span>
                    </Td>
                    <Td>
                      <StatusPill tone={outcome.tone}>{outcome.label}</StatusPill>
                    </Td>
                    <Td numeric muted>
                      {m.finishedAt ? durationText(m.finishedAt.getTime() - m.startedAt.getTime()) : "—"}
                    </Td>
                    <RowActionsCell>
                      <OutputPaneButton title={`Migration output · ${schemaLabel(m.toVersion)}`} output={m.output} />
                    </RowActionsCell>
                  </Tr>
                );
              })}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Scheduled jobs" description="Platform jobs that work on this workspace, and how each last went." padded={false}>
        {ops.leases.length === 0 ? (
          <EmptyState icon={<Clock className="h-5 w-5" />} title="No scheduled job has run for it yet" />
        ) : (
          <DataTable caption="Scheduled jobs" minWidth={760}>
            <THead>
              <Th>Job</Th>
              <Th>State</Th>
              <Th>Last started</Th>
              <Th>Last finished</Th>
              <Th>Error</Th>
            </THead>
            <TBody>
              {ops.leases.map((l) => {
                const outcome = leaseOutcome(l);
                return (
                  <Tr key={l.job}>
                    <Td>
                      <span className="block font-medium text-text">{l.label}</span>
                      {l.label !== l.job && <span className="block font-mono text-[11px] text-subtle">{l.job}</span>}
                    </Td>
                    <Td>
                      <StatusPill tone={outcome.tone} dot={l.runningNow}>
                        {outcome.label}
                      </StatusPill>
                      {l.runningNow && <span className="mt-1 block text-[11px] break-all text-subtle">{`Running now on ${l.holder}`}</span>}
                    </Td>
                    <Td muted nowrap>
                      {l.lastStartedAt ? <RelativeTime at={l.lastStartedAt} /> : "—"}
                    </Td>
                    <Td muted nowrap>
                      {l.lastFinishedAt ? <RelativeTime at={l.lastFinishedAt} /> : "—"}
                    </Td>
                    <Td>{l.lastError && l.lastOk === false ? <ErrorDetails error={l.lastError} /> : <span className="text-muted">—</span>}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </DataTable>
        )}
      </Panel>

      <Panel title="Terminals" description="Attendance terminals whose punches are routed to it." actions={<SeeAll href={`/devices?tenant=${slugParam}`}>Terminals</SeeAll>} padded={false}>
        {ops.terminals.length === 0 ? (
          <EmptyState icon={<Cpu className="h-5 w-5" />} title="No terminals" body="No attendance terminal is routed to this workspace." />
        ) : (
          <DataTable caption="Terminals" minWidth={640}>
            <THead>
              <Th>Serial</Th>
              <Th>Added</Th>
              <Th>Last seen</Th>
              {manage && <Th srOnly>Release</Th>}
            </THead>
            <TBody>
              {ops.terminals.map((t) => {
                const state = TERMINAL_STATE[t.state] ?? { label: t.state, tone: "neutral" as const };
                return (
                  <Tr key={t.serial}>
                    <Td>
                      <CopyField value={t.serial} label="serial" />
                    </Td>
                    <Td muted nowrap>
                      <RelativeTime at={t.createdAt} absolute="date" />
                    </Td>
                    <Td nowrap>
                      {t.lastSeenAt ? (
                        <span className="inline-flex items-center gap-2">
                          <StatusDot tone={state.tone} label={state.label} />
                          <RelativeTime at={t.lastSeenAt} className="text-muted" />
                        </span>
                      ) : (
                        <span className="text-muted">{state.label}</span>
                      )}
                    </Td>
                    {manage && (
                      <RowActionsCell>
                        <ActionButton
                          action={consoleReleaseDevice.bind(null, t.serial)}
                          label="Release"
                          variant="ghost"
                          confirm={{
                            title: "Release terminal",
                            body: `${t.serial} stops routing to this workspace. Its punches are refused until a workspace registers it again.`,
                            confirmLabel: "Release terminal",
                            tone: "danger",
                          }}
                          success="Terminal released."
                        />
                      </RowActionsCell>
                    )}
                  </Tr>
                );
              })}
            </TBody>
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
