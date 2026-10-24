import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { PageHeader } from "@/components/console/kit/page-header";
import { DefinitionList, Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { OffsiteStoreEditor, RunOffsiteButton } from "@/components/console/settings/offsite-settings";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import type { Tone } from "@/lib/console-shared/types";
import { offsiteStatus, type RunRow } from "@/lib/offsite/status";
import { consoleStaff } from "@/lib/platform/console-page";
import { CLOCK_TOLERANCE_MS } from "@/lib/platform/time-sync";

export const metadata: Metadata = { title: "Backups & logs" };

/**
 * Settings › Backups & logs (owner, 24 Oct 2026; src/lib/offsite): where backups and logs are kept off the
 * server and for how long, what has run and how it went, the restore drills, and what CERT-In asks for —
 * the access log, a year of logs, the clock. Settings' own gate; only an owner changes the store, owners and
 * admins may check it and run things now (src/actions/platform/console-offsite.ts checks again). No secret
 * reaches the page.
 */

const LINK = "inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline";

const KIND_LABEL: Record<RunRow["kind"], string> = { SYNC: "Backups off-site", CONTROL_DUMP: "Control plane dump", LOGS: "Log archive", DRILL: "Restore drill" };

function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return bytes ? `${Math.max(1, Math.round(bytes / 1024))} KB` : "—";
}

function Result({ run }: { run: RunRow | undefined }) {
  if (!run) return <StatusPill tone="neutral">Never run</StatusPill>;
  const map: Record<RunRow["status"], { tone: Tone; label: string }> = {
    RUNNING: { tone: "info", label: "Running" },
    SUCCEEDED: { tone: "success", label: "Done" },
    FAILED: { tone: "danger", label: "Failed" },
  };
  return (
    <StatusPill tone={map[run.status].tone} dot>
      {map[run.status].label}
    </StatusPill>
  );
}

function RunText({ run }: { run: RunRow | undefined }) {
  if (!run) return <span className="text-muted">—</span>;
  return (
    <span className="block space-y-0.5">
      {run.summary && <span className="block text-text">{run.summary}</span>}
      {run.error && <span className="block whitespace-pre-line text-xs text-danger">{run.error}</span>}
    </span>
  );
}

export default async function ConsoleOffsitePage() {
  const staff = await consoleStaff(PAGE_ROLES.settings);
  const caps = capsFor(staff.role);
  const status = await offsiteStatus().catch(() => null);

  const header = (
    <PageHeader
      title="Backups & logs"
      chips={caps.owner ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
      subtitle="Copies of every workspace's backups, the control plane and the logs, kept off this server — and restored once a week to prove they work."
      actions={
        <Link href="/settings" className={LINK}>
          All settings
        </Link>
      }
    />
  );
  if (!status) {
    return (
      <>
        {header}
        <Banner tone="warning" title="Not ready yet">
          {"This release's database migrations haven't run here, so there is nothing to show. Run npm run tenants:migrate, then reload."}
        </Banner>
      </>
    );
  }

  const configured = !!status.setup.config;
  const canRun = caps.manage;
  const clock = status.clock;
  const clockTone: Tone = !clock ? "neutral" : clock.offsetMs === null ? "warning" : Math.abs(clock.offsetMs) > CLOCK_TOLERANCE_MS ? "danger" : "success";
  const rows: { kind: RunRow["kind"]; label: string; every: string; run?: RunRow; chore: "sync" | "control" | "logs" | "drill" | "clock"; needsStore: boolean }[] = [
    { kind: "SYNC", label: KIND_LABEL.SYNC, every: "Every hour", run: status.latest.SYNC, chore: "sync", needsStore: true },
    { kind: "CONTROL_DUMP", label: KIND_LABEL.CONTROL_DUMP, every: "Every night, after 01:00", run: status.latest.CONTROL_DUMP, chore: "control", needsStore: false },
    { kind: "LOGS", label: KIND_LABEL.LOGS, every: "Every night, after 01:00", run: status.latest.LOGS, chore: "logs", needsStore: true },
    { kind: "DRILL", label: KIND_LABEL.DRILL, every: "Every week, 03:00–07:00", run: status.latest.DRILL, chore: "drill", needsStore: true },
  ];

  return (
    <>
      {header}
      <div className="space-y-5">
        {!configured && (
          <Banner tone="warning" title="Nothing is kept off this server">
            Losing this server would lose every workspace&apos;s backups, the control plane — whose keys every backup needs — and the logs CERT-In
            requires. Set up a store below; in India (Azure Central India, AWS Mumbai), so the logs stay in the country.
          </Banner>
        )}
        {status.requested && (
          <Banner tone="info" title="Waiting for the platform worker">
            {`${status.requested.chore === "drill" ? "A restore drill" : status.requested.chore === "sync" ? "A backup sync" : status.requested.chore === "control" ? "A control plane dump" : status.requested.chore === "logs" ? "The log archive" : "A clock check"} was asked for and starts within a minute. If it doesn't, the worker isn't running (DESKZO_WORKER=in-app, or npm run platform:worker).`}
          </Banner>
        )}

        <Panel id="store" title="Off-site store" description="Where copies go. Everything is encrypted on this server before it leaves, under keys from PLATFORM_MASTER_KEY — the store only ever holds ciphertext.">
          <OffsiteStoreEditor
            config={status.config}
            label={status.label}
            secretSet={status.setup.secretSet}
            backupKeepDays={status.setup.backupKeepDays}
            logKeepDays={status.setup.logKeepDays}
            canEdit={caps.owner}
            canCheck={canRun}
          />
        </Panel>

        <Panel id="runs" title="What runs" description="By the platform worker, beside its other work. Times are the console's." padded={false}>
          <DataTable minWidth={760} caption="Off-site work and how it last went">
            <THead>
              <Th>Work</Th>
              <Th>Last run</Th>
              <Th>Result</Th>
              <Th>What it did</Th>
              {canRun && <Th srOnly>Run now</Th>}
            </THead>
            <TBody>
              {rows.map((r) => (
                <Tr key={r.kind}>
                  <Td nowrap>
                    <span className="block font-medium">{r.label}</span>
                    <span className="block text-xs text-muted">{r.every}</span>
                  </Td>
                  <Td nowrap muted>
                    {r.run ? <RelativeTime at={r.run.startedAt} /> : "—"}
                    {status.lastSucceeded[r.kind] && r.run?.status !== "SUCCEEDED" && (
                      <span className="block text-xs">
                        last done <RelativeTime at={status.lastSucceeded[r.kind]!} />
                      </span>
                    )}
                  </Td>
                  <Td nowrap>
                    <Result run={r.run} />
                  </Td>
                  <Td className="min-w-72 text-xs">
                    <RunText run={r.run} />
                  </Td>
                  {canRun && (
                    <Td nowrap>
                      <RunOffsiteButton chore={r.chore} label="Run now" disabled={r.needsStore && !configured} />
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>

        <div className="grid gap-5 lg:grid-cols-2">
          <Panel id="workspaces" title="Workspaces" description="Each workspace's own scheduled backups, copied as they are taken.">
            <DefinitionList
              items={[
                { term: "With backups off-site", value: `${status.workspaces.offsite} of ${plural(status.workspaces.live, "workspace")}` },
                { term: "Last copied", value: status.workspaces.newestSync ? <RelativeTime at={status.workspaces.newestSync} /> : "Never" },
                {
                  term: "Failing",
                  wide: true,
                  value: status.workspaces.failing.length ? (
                    <ul className="space-y-1">
                      {status.workspaces.failing.slice(0, 10).map((f) => (
                        <li key={f.id} className="text-xs">
                          <Link href={`/workspaces/${encodeURIComponent(f.slug)}`} className="font-medium text-brand hover:underline">
                            {f.slug}
                          </Link>{" "}
                          <span className="text-danger">{f.error}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    "None"
                  ),
                },
              ]}
            />
          </Panel>

          <Panel
            id="cert-in"
            title="CERT-In"
            description="What the Directions of 28 April 2022 ask of a service provider (docs/runbook.md §14)."
            footer={canRun ? <RunOffsiteButton chore="clock" label="Check the clock now" /> : undefined}
          >
            <DefinitionList
              columns={1}
              items={[
                {
                  term: "Web access log",
                  value: status.accessLog.enabled ? (
                    <Stated tone="success" label="On">
                      Every request, a file a day per process, in <span className="font-mono text-xs break-all">{status.accessLog.dir}</span>.
                    </Stated>
                  ) : (
                    <Stated tone="warning" label="Off">
                      On in production, or with ACCESS_LOG=on. Without it, keep the access log of whatever is in front of the app instead.
                    </Stated>
                  ),
                },
                {
                  term: "Logs kept",
                  value: configured ? (
                    <Stated tone="success" label={`${status.setup.logKeepDays} days`}>
                      Off-site, sealed: the access log, every workspace&apos;s sign-ins, activity and audit log, and the console&apos;s, CMS&apos;s and
                      partner portal&apos;s.
                    </Stated>
                  ) : (
                    <Stated tone="warning" label="On this server only">
                      {`The access log is kept ${status.setup.logKeepDays} days on this server's disk; the workspaces' security logs only as long as each workspace's own retention.`}
                    </Stated>
                  ),
                },
                {
                  term: "Clock",
                  value: !clock ? (
                    <Stated tone="neutral" label="Not checked yet">
                      Checked once a day against NPL&apos;s and NIC&apos;s time servers.
                    </Stated>
                  ) : clock.offsetMs === null ? (
                    <Stated tone="warning" label="Couldn't check">
                      {clock.error ?? "No time server answered."}
                    </Stated>
                  ) : (
                    <Stated tone={clockTone} label={`${Math.abs(clock.offsetMs)} ms ${clock.offsetMs < 0 ? "behind" : "ahead"}`}>
                      Against {clock.server}, <RelativeTime at={clock.at} />.{" "}
                      {Math.abs(clock.offsetMs) > CLOCK_TOLERANCE_MS ? "More than a second out — set the server's time service to NPL and NIC (docs/runbook.md §14)." : ""}
                    </Stated>
                  ),
                },
                { term: "Incidents", value: "Reported to CERT-In within 6 hours of noticing them — the steps are in docs/runbook.md §14." },
              ]}
            />
          </Panel>
        </div>

        <Panel id="drills" title="Restore drills" description="A backup fetched back from the store, restored into a scratch database and read — the newest of one workspace, and the control plane's newest dump." padded={false}
          actions={canRun && configured ? <RunOffsiteButton chore="drill" label="Run a drill" withWorkspace /> : undefined}
        >
          {status.drills.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">None yet. The first runs in the first early morning after backups are off-site.</p>
          ) : (
            <DataTable minWidth={680} caption="Recent restore drills">
              <THead>
                <Th>When</Th>
                <Th>Of</Th>
                <Th>Result</Th>
                <Th>What it found</Th>
              </THead>
              <TBody>
                {status.drills.map((d) => (
                  <Tr key={d.id}>
                    <Td nowrap muted>
                      <RelativeTime at={d.startedAt} />
                    </Td>
                    <Td nowrap>{d.tenant ? d.tenant.slug : "Control plane"}</Td>
                    <Td nowrap>
                      <Result run={d} />
                    </Td>
                    <Td className="text-xs">
                      <RunText run={d} />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>

        <Panel id="history" title="Recent runs" description="The last 30, newest first. Kept half a year." padded={false}>
          {status.recent.length === 0 ? (
            <p className="px-5 py-4 text-sm text-muted">Nothing has run yet.</p>
          ) : (
            <DataTable minWidth={760} caption="Recent off-site runs">
              <THead>
                <Th>When</Th>
                <Th>Work</Th>
                <Th>Result</Th>
                <Th numeric>Sent</Th>
                <Th>Started by</Th>
              </THead>
              <TBody>
                {status.recent.map((r) => (
                  <Tr key={r.id}>
                    <Td nowrap muted>
                      <RelativeTime at={r.startedAt} />
                    </Td>
                    <Td nowrap>{KIND_LABEL[r.kind]}{r.tenant ? ` · ${r.tenant.slug}` : ""}</Td>
                    <Td nowrap>
                      <Result run={r} />
                    </Td>
                    <Td numeric nowrap>
                      {size(r.bytes)}
                    </Td>
                    <Td nowrap muted>
                      {r.startedBy === "worker" ? "Schedule" : r.startedBy.startsWith("staff:") ? "Staff" : r.startedBy}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>
      </div>
    </>
  );
}

function Stated({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  return (
    <span className="flex flex-wrap items-start gap-2">
      <StatusPill tone={tone}>{label}</StatusPill>
      <span className="min-w-0 flex-1 text-sm text-text">{children}</span>
    </span>
  );
}
