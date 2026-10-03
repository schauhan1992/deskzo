import Link from "next/link";
import { ArrowRight, KeyRound } from "lucide-react";
import { DefinitionList, InsetBlock, Panel } from "@/components/console/kit/panel";
import { StatusPill, TenantStatusPill } from "@/components/console/kit/status";
import { EnterAsSupport } from "@/components/console/workspace/enter-as-support";
import { grantLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import { consoleClock } from "@/lib/platform/console-clock";
import type { ConsoleEntry, PerfSnapshot, SupportDetail } from "@/lib/support/types";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";
import { fileSize } from "./attachments";

/**
 * The request detail's right-hand column: who asked, from which workspace (and whether staff may go
 * in), what their browser said about itself — and, only when they consented to a screen recording,
 * the console messages and page timings captured with it. Server components; everything is text,
 * times on the console's clock.
 */

const LINK = "inline-flex items-center gap-1 rounded-base font-medium text-brand hover:underline";
const dash = (value: string | null | undefined) => (value && value.trim() ? value : "—");

export function RequesterPanel({ requester }: { requester: SupportDetail["requester"] }) {
  return (
    <Panel title="Requester">
      <DefinitionList
        columns={1}
        items={[
          { term: "Name", value: requester.name },
          { term: "Email", value: <span className="break-all">{requester.email}</span> },
          { term: "Role in the workspace", value: dash(requester.role) },
          { term: "Mobile", value: dash(requester.mobile) },
        ]}
      />
    </Panel>
  );
}

/**
 * The workspace, linking to its 360, and the way in: with a live grant from its super admin,
 * "Enter as support" (the same one-time pass as on the 360); without one, what to ask the customer.
 */
export async function WorkspacePanel({ detail, caps }: { detail: SupportDetail; caps: Caps }) {
  const clock = await consoleClock();
  const ws = detail.workspace;
  const grant = detail.grant;
  const live = grant ? grantLabel("live", grant.level) : null;
  const href = `/workspaces/${encodeURIComponent(ws.slug)}`;
  return (
    <Panel
      title="Workspace"
      footer={
        <Link href={href} className={LINK}>
          Open its 360
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        </Link>
      }
    >
      <div className="space-y-4">
        <DefinitionList
          columns={1}
          items={[
            {
              term: "Name",
              value: (
                <Link href={href} className="font-medium text-text hover:text-brand">
                  {ws.name}
                </Link>
              ),
            },
            { term: "Address", value: <span className="font-mono text-xs break-all">{ws.slug}</span> },
            { term: "Plan", value: ws.plans.length ? ws.plans.map((p) => p.name).join(", ") : "No plan" },
            { term: "Status", value: <TenantStatusPill status={ws.status} /> },
          ]}
        />

        <div className="space-y-2 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-medium text-text">Support access</h3>
            {live ? <StatusPill tone={live.tone} dot>{`${live.label} · live`}</StatusPill> : <StatusPill tone="neutral">Not granted</StatusPill>}
          </div>
          {grant ? (
            <>
              <InsetBlock>
                <p className="text-sm text-text">{`${live?.label ?? "Access"} granted by ${grant.grantedByName} until ${clock.dateTime(grant.expiresAt)}`}</p>
              </InsetBlock>
              {caps.enter &&
                (ws.status === "ACTIVE" ? (
                  <EnterAsSupport tenantId={ws.id} variant="secondary" />
                ) : (
                  <p className="text-xs text-muted">Workspace is not open — support can go in once it is active again.</p>
                ))}
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-xs text-muted">
              <KeyRound aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              Ask the customer to grant support access in Settings → Security.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** What the browser said about itself (disclosed in the dialog), plus the address the server saw. */
export function ContextPanel({ context }: { context: SupportDetail["context"] }) {
  return (
    <Panel title="Context" description="Sent with every request; the dialog tells the customer so.">
      <DefinitionList
        columns={1}
        items={[
          { term: "Page", value: <span className="font-mono text-xs break-all">{dash(context.page)}</span> },
          {
            term: "Browser",
            value: (
              <span className="block">
                {dash(context.browser)}
                {context.userAgent && <span className="mt-0.5 block font-mono text-[11px] break-all text-subtle">{context.userAgent}</span>}
              </span>
            ),
          },
          { term: "Screen", value: context.viewport ? `${dash(context.screen)} · window ${context.viewport}` : dash(context.screen) },
          { term: "Time zone", value: dash(context.timezone) },
          { term: "Language", value: dash(context.language) },
          { term: "IP address", value: <span className="font-mono text-xs">{dash(context.ip)}</span> },
          ...(context.appVersion ? [{ term: "App version", value: <span className="font-mono text-xs break-all">{context.appVersion}</span> }] : []),
        ]}
      />
    </Panel>
  );
}

/** "14:02:07" — the entry's time of day on the console's clock, from its ISO stamp; the stamp itself when it is not one. */
function timeOfDay(iso: string, clock: Clock): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso || "—";
  const { hour, minute, second } = clock.parts(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hour)}:${pad(minute)}:${pad(second)}`;
}

const PERF_ROWS: { key: keyof PerfSnapshot; label: string }[] = [
  { key: "dns", label: "DNS lookup" },
  { key: "tcp", label: "Connection" },
  { key: "ttfb", label: "First byte" },
  { key: "domContentLoaded", label: "Page ready (DOMContentLoaded)" },
  { key: "load", label: "Fully loaded" },
  { key: "transferSize", label: "Transferred" },
];

/**
 * Captured only while a consented recording ran: the browser's errors and warnings (levels in their
 * colour and in words), and the page's load timings. Collapsed by default — it can be 200 lines.
 */
export async function RecordingDiagnostics({ consoleLog, perf, consentAt }: { consoleLog: ConsoleEntry[] | null; perf: PerfSnapshot | null; consentAt: Date | null }) {
  const clock = await consoleClock();
  const log = consoleLog ?? [];
  const errors = log.filter((e) => e.level === "error").length;
  const warnings = log.length - errors;
  const perfRows = perf ? PERF_ROWS.filter((r) => typeof perf[r.key] === "number") : [];
  return (
    <Panel title="Captured with the recording" description={consentAt ? `The customer consented ${clock.dateTime(consentAt)}.` : undefined}>
      <div className="space-y-4">
        {log.length === 0 ? (
          <p className="text-sm text-muted">No console errors or warnings while recording.</p>
        ) : (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-text select-none">
              {`Console log · ${errors} ${errors === 1 ? "error" : "errors"}, ${warnings} ${warnings === 1 ? "warning" : "warnings"}`}
            </summary>
            <ol aria-label="Console messages" className="mt-2 max-h-96 space-y-1 overflow-y-auto rounded-lg border border-line bg-surface-sunken p-2 font-mono text-[11px] leading-4">
              {log.map((e, i) => (
                <li key={`${i}-${e.at}`} className="flex gap-2">
                  <span className="shrink-0 text-subtle">{timeOfDay(e.at, clock)}</span>
                  <span className={cn("w-10 shrink-0 font-semibold uppercase", e.level === "error" ? "text-danger" : "text-warning")}>{e.level === "error" ? "error" : "warn"}</span>
                  <span className="min-w-0 break-words whitespace-pre-wrap text-text">{e.message}</span>
                </li>
              ))}
            </ol>
          </details>
        )}

        {perfRows.length > 0 && perf && (
          <div>
            <h3 className="text-[13px] font-medium text-text">Page-load timings</h3>
            <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
              {perfRows.map((r) => (
                <div key={r.key} className="contents">
                  <dt className="text-muted">{r.label}</dt>
                  <dd className="text-right text-text tabular-nums">{r.key === "transferSize" ? fileSize(perf[r.key] ?? 0) : `${(perf[r.key] ?? 0).toLocaleString("en-IN")} ms`}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </Panel>
  );
}
