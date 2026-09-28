import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusDot, StatusPill } from "@/components/console/kit/status";
import { HEALTH_STATUS } from "@/lib/console-shared/labels";
import type { Tone } from "@/lib/console-shared/types";
import type { HealthCheck, HealthGroup } from "@/lib/platform/health";

/**
 * The System health board's checks (spec §3.11), one card per area in a fixed order, so each card is
 * where it was last time: background work, provisioning and schemas down the left with billing;
 * reference data, security and configuration down the right. Each row is a dot, what is checked, what
 * was found, since when, and a link to the page that deals with it.
 *
 * Server-rendered from `systemHealth()`; the page has already dropped the billing card for staff who
 * do not sell. A check the loader could not work out arrives as a failing row saying so.
 */

type GroupSpec = { key: HealthGroup; label: string; description: string };

const LEFT: GroupSpec[] = [
  { key: "background", label: "Background work", description: "The platform tick, the daily chores and migration runs" },
  { key: "provisioning", label: "Provisioning", description: "Setting up new workspaces" },
  { key: "schemas", label: "Schemas", description: "The control plane's database and every workspace's" },
  { key: "billing", label: "Billing", description: "Gateway keys and webhooks" },
];
const RIGHT: GroupSpec[] = [
  { key: "reference", label: "Reference data", description: "PIN codes and places for address lookups" },
  { key: "security", label: "Security", description: "Staff sign-in, the console's network and platform mail" },
  { key: "configuration", label: "Configuration", description: "What the environment sets — never a value" },
];

function groupSummary(checks: HealthCheck[]): { label: string; tone: Tone } {
  const count = (status: HealthCheck["status"]) => checks.filter((c) => c.status === status).length;
  const fail = count("fail");
  const warn = count("warn");
  if (fail) return { label: `${fail} failing`, tone: "danger" };
  if (warn) return { label: `${warn} to check`, tone: "warning" };
  if (!count("ok")) return { label: "Off", tone: "neutral" };
  return { label: "OK", tone: "success" };
}

export function CheckGrid({ checks }: { checks: HealthCheck[] }) {
  const column = (specs: GroupSpec[]) =>
    specs.map((spec) => {
      const rows = checks.filter((c) => c.group === spec.key);
      return rows.length > 0 ? <CheckCard key={spec.key} spec={spec} rows={rows} /> : null;
    });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <div className="min-w-0 space-y-6">{column(LEFT)}</div>
      <div className="min-w-0 space-y-6">{column(RIGHT)}</div>
    </div>
  );
}

function CheckCard({ spec, rows }: { spec: GroupSpec; rows: HealthCheck[] }) {
  const summary = groupSummary(rows);
  return (
    <Panel
      // Anchors the alerts and other pages link to: /health#configuration, /health#background…
      id={spec.key}
      title={spec.label}
      description={spec.description}
      padded={false}
      actions={
        <StatusPill tone={summary.tone} dot>
          {summary.label}
        </StatusPill>
      }
    >
      <ul className="divide-y divide-line">
        {rows.map((check) => (
          <CheckRow key={check.key} check={check} />
        ))}
      </ul>
    </Panel>
  );
}

function CheckRow({ check }: { check: HealthCheck }) {
  const status = HEALTH_STATUS[check.status] ?? HEALTH_STATUS.off;
  const flagged = check.status === "fail" || check.status === "warn";
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <span className="mt-1.5">
        <StatusDot tone={status.tone} label={status.label} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-text">{check.label}</p>
          {/* The dot already says it to a screen reader; the pill is for the eye scanning a long card. */}
          {flagged && (
            <span aria-hidden="true">
              <StatusPill tone={status.tone}>{status.label}</StatusPill>
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs break-words text-muted">{check.detail}</p>
        {check.since && <RelativeTime at={check.since} className="mt-1 block text-[11px] text-subtle" />}
      </div>
      {check.href && (
        <Link
          href={check.href}
          className="-mr-2 inline-flex h-7 shrink-0 items-center gap-1 rounded-base px-2 text-xs font-medium text-brand hover:bg-surface-sunken"
        >
          Open<span className="sr-only">{` ${check.label}`}</span>
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      )}
    </li>
  );
}
