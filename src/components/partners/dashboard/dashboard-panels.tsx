import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, CalendarClock, CircleCheck, Circle, Hourglass, UserPlus } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { MoneyStack } from "@/components/partners/common/money";
import { SourceLabel } from "@/components/partners/common/pills";
import { CustomerName } from "@/components/partners/customers/customer-name";
import { plural } from "@/lib/console-shared/format";
import type { PortalDashboard } from "@/lib/partners/portal-data";
import type { Clock } from "@/lib/time/zone";
import { cn } from "@/lib/utils";

/**
 * The dashboard's lists and its setup checklist. Dates are on `clock` — the console's (Settings › Time
 * zone), which the portal keeps — and every "in N days" is counted in its calendar days from the
 * loader's `asOf`, never from the reader's clock, so the page says the same thing on the server and in
 * the browser. A customer's name links to its page (the view gives a slug only for the partner's own
 * current customers).
 *
 * Server-safe: no hooks, no directive.
 */

/** "today", "tomorrow", "in 5 days" — from the loader's clock. */
export function inDays(asOf: Date, at: Date, clock: Clock): string {
  const days = clock.daysBetween(asOf, at);
  if (days <= 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${plural(days, "day")}`;
}

function ListRow({ name, slug, meta, side }: { name: string; slug: string; meta?: ReactNode; side?: ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 px-5 py-2.5">
      <div className="min-w-0">
        <CustomerName slug={slug} name={name} className="block truncate" />
        {meta && <div className="mt-0.5 text-xs text-muted">{meta}</div>}
      </div>
      {side && <div className="shrink-0 text-right text-sm">{side}</div>}
    </li>
  );
}

/** Trials ending within 14 days, soonest first. */
export function TrialsEndingPanel({ rows, asOf, clock }: { rows: PortalDashboard["trialsEnding"]; asOf: Date; clock: Clock }) {
  return (
    <Panel title="Trials ending" description="In the next 14 days — a good moment to check in." padded={rows.length === 0}>
      {rows.length === 0 ? (
        <EmptyState icon={<Hourglass className="h-5 w-5" />} title="No trials end in the next 14 days" body="Customers on a trial appear here as their trial nears its end." />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <ListRow
              key={`${row.slug}-${row.endsAt.toISOString()}`}
              name={row.name}
              slug={row.slug}
              meta={`Trial ends ${clock.date(row.endsAt)}`}
              side={<span className="font-medium whitespace-nowrap text-info">{`Ends ${inDays(asOf, row.endsAt, clock)}`}</span>}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Renewals and cancellations taking effect within 30 days, soonest first; a cancellation is marked. */
export function RenewalsPanel({ rows, asOf, clock }: { rows: PortalDashboard["renewals"]; asOf: Date; clock: Clock }) {
  return (
    <Panel title="Renewals and cancellations due" description="In the next 30 days, with what each brings in a month." padded={rows.length === 0}>
      {rows.length === 0 ? (
        <EmptyState icon={<CalendarClock className="h-5 w-5" />} title="Nothing renews or ends in the next 30 days" body="Paid subscriptions appear here as their renewal nears." />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <ListRow
              key={`${row.slug}-${row.at.toISOString()}`}
              name={row.name}
              slug={row.slug}
              meta={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {row.ending ? <StatusPill tone="warning">Cancels</StatusPill> : <StatusPill tone="success">Renews</StatusPill>}
                  <span>{`${clock.dayMonth(row.at)} · ${inDays(asOf, row.at, clock)}`}</span>
                </span>
              }
              side={<MoneyStack items={row.mrr} className="text-sm" />}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The newest customers, and how each came. */
export function LatestCustomersPanel({ rows, action, clock }: { rows: PortalDashboard["latest"]; action?: ReactNode; clock: Clock }) {
  return (
    <Panel title="Latest customers" description="The newest workspaces credited to you." padded={rows.length === 0}>
      {rows.length === 0 ? (
        <EmptyState icon={<UserPlus className="h-5 w-5" />} title="No customers yet" body="Share an invitation code or your referral link to bring your first customer." action={action} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <ListRow
              key={`${row.slug}-${row.since.toISOString()}`}
              name={row.name}
              slug={row.slug}
              meta={<SourceLabel source={row.source} />}
              side={<span className="whitespace-nowrap text-muted">{clock.date(row.since)}</span>}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

type Step = { key: string; done: boolean; title: string; body: string; href: string | null; linkLabel: string };

/**
 * While the partner account is being set up (ONBOARDING): the three things that make it ready — a
 * team, a complete company profile, payout details on file — each ticked when done, with the way to
 * it for a role that may open that page.
 */
export function SetupChecklist({
  setup,
  teamHref,
  profileHref,
}: {
  setup: NonNullable<PortalDashboard["setup"]>;
  /** The team page (with its invite dialog open), or null for a role that cannot open it. */
  teamHref: string | null;
  profileHref: string;
}) {
  const steps: Step[] = [
    {
      key: "team",
      done: setup.teamInvited,
      title: "Invite your team",
      body: "Add the people who sell and who look after the money, each with the role they need.",
      href: teamHref,
      linkLabel: "Go to Team",
    },
    {
      key: "profile",
      done: setup.profileComplete,
      title: "Complete your company profile",
      body: "Your address — first line, city and postal code — goes on every statement.",
      href: profileHref,
      linkLabel: "Go to Company profile",
    },
    {
      key: "payout",
      done: setup.payoutOnFile,
      title: "Put payout details on file",
      body: "The bank account your commission is paid into. An admin or a finance user submits them from the company profile.",
      href: profileHref,
      linkLabel: "Go to Company profile",
    },
  ];
  const done = steps.filter((s) => s.done).length;
  return (
    <Panel title="Finish setting up" description={`${done} of ${steps.length} done. Codes and registrations open once your partner account is active.`}>
      <ol className="space-y-3">
        {steps.map((step) => (
          <li key={step.key} className="flex items-start gap-3">
            <span aria-hidden="true" className={cn("mt-0.5 shrink-0", step.done ? "text-success" : "text-subtle")}>
              {step.done ? <CircleCheck className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm font-medium", step.done ? "text-muted" : "text-text")}>
                {step.title}
                <span className="sr-only">{step.done ? " — done" : " — to do"}</span>
              </p>
              {!step.done && <p className="mt-0.5 text-xs text-muted">{step.body}</p>}
            </div>
            {!step.done && step.href && (
              <Link href={step.href} className="inline-flex shrink-0 items-center gap-1 rounded-base text-xs font-medium text-brand hover:underline">
                {step.linkLabel}
                <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
