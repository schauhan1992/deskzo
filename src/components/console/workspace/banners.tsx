import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { consoleMigrateWorkspace, consoleResume } from "@/actions/platform/console";
import { ActionButton } from "@/components/console/kit/action-button";
import { Banner } from "@/components/console/kit/banner";
import { AutoRefresh } from "@/components/console/kit/refresh";
import { StandingPill } from "@/components/console/kit/status";
import { plural } from "@/lib/console-shared/format";
import { gatewayLabel, schemaLabel } from "@/lib/console-shared/labels";
import type { Caps } from "@/lib/console-shared/roles";
import { consoleClock } from "@/lib/platform/console-clock";
import type { WorkspaceHeader } from "@/lib/platform/workspace-data";
import type { Clock } from "@/lib/time/zone";
import { TabLink } from "./header-actions";

/**
 * What to read about this workspace before anything else on its page — only the states that are
 * true right now, most serious first: closed, held (by whom and why), held for billing, held for a
 * failed migration, being set up, about to be held, paying twice over, behind on its schema, a trial
 * about to end. Each says what it means and, where there is one, offers the next step to the roles
 * that can take it. A server component: its days are on the console's clock.
 *
 * `setup` (an addition to spec §4.7): its newest provisioning job, for the "being set up" banner's
 * step — the header loader does not read jobs, the Operations loader does.
 */

type SetupJob = { status: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED"; step: string; attempts: number; error: string | null };

const LINK_BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

/** "in 5 days", "today", "tomorrow" — counted in the console's days from the loader's time. */
function inDays(at: Date, asOf: Date, clock: Clock): string {
  const days = clock.daysBetween(asOf, at);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days > 0 ? `in ${plural(days, "day")}` : `${plural(-days, "day")} ago`;
}

const firstLine = (text: string) => text.split("\n").find((l) => l.trim())?.trim() ?? text;

export async function WorkspaceBanners({ header, caps, setup = null }: { header: WorkspaceHeader; caps: Caps; setup?: SetupJob | null }) {
  const clock = await consoleClock();
  const { tenant, standing, asOf } = header;
  const slug = encodeURIComponent(tenant.slug);
  const tabHref = (tab: string) => `/workspaces/${slug}?tab=${tab}`;
  const toTab = (tab: string, label: string) => (
    <TabLink tab={tab} href={tabHref(tab)} className={LINK_BUTTON}>
      {label}
    </TabLink>
  );
  const banners: { key: string; node: ReactNode }[] = [];
  const add = (key: string, node: ReactNode) => banners.push({ key, node });

  const active = tenant.status === "ACTIVE";
  const heldByStaff = tenant.status === "SUSPENDED" && tenant.suspendedFor !== "BILLING";
  const heldForBilling = tenant.status === "SUSPENDED" && tenant.suspendedFor === "BILLING";

  if (header.closed) {
    const { at, backup, purgeDueAt } = header.closed;
    add(
      "closed",
      <Banner tone="neutral" title={`Closed on ${clock.date(at)}`}>
        {backup ? (
          <>
            Final backup <span className="font-mono text-xs break-all">{backup}</span>
          </>
        ) : (
          "No final backup — it had no database of its own"
        )}
        {` · purge due ${clock.date(purgeDueAt)}. Until then its keys are kept, so the backup can still be read.`}
      </Banner>,
    );
  }

  if (heldByStaff) {
    const hold = header.hold;
    const since = hold?.since ? ` since ${clock.dayMonth(hold.since)}` : "";
    const by = hold?.by ? ` by ${hold.by}` : " by staff";
    add(
      "held",
      <Banner
        tone="warning"
        title={`Held${since}${by}`}
        action={
          caps.manage ? (
            <ActionButton
              action={consoleResume.bind(null, tenant.id)}
              label="Reopen workspace"
              confirm={{ title: "Reopen workspace", body: "Its staff and users can sign in again at once.", confirmLabel: "Reopen workspace" }}
              success="Workspace reopened."
            />
          ) : undefined
        }
      >
        {hold?.reason ? `“${hold.reason}”` : "No reason was recorded."} Its staff and users are locked out until staff reopen it; paying does not lift it.
      </Banner>,
    );
  }

  if (heldForBilling) {
    const since = header.hold?.since ?? tenant.suspendedAt;
    add(
      "billing-hold",
      <Banner tone="danger" title={`Held for billing${since ? ` since ${clock.dayMonth(since)}` : ""}`} action={toTab("billing", "Open Billing")}>
        <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
          Its standing: <StandingPill kind={standing.kind} at={header.standingAt} asOf={asOf} />
        </span>{" "}
        It opens again by itself once it pays — at the next platform tick, or when billing rules are applied.
      </Banner>,
    );
  }

  if (tenant.status === "MIGRATING") {
    add(
      "migrating",
      <Banner
        tone="danger"
        title="Held for a failed migration"
        action={
          caps.manage ? (
            <ActionButton
              action={consoleMigrateWorkspace.bind(null, tenant.slug)}
              label="Retry migration"
              confirm={{
                title: "Retry migration",
                body: "Runs its workspace migrations again now. It opens again once they succeed; if one fails, it stays held and the output is under Operations.",
                confirmLabel: "Retry migration",
              }}
              success="Migrated — it is open again."
            />
          ) : (
            toTab("operations", "See the runs")
          )
        }
      >
        {`Its database is on ${schemaLabel(tenant.schemaVersion)}. Its staff and users are locked out until a migration run succeeds.`}
      </Banner>,
    );
  }

  if (tenant.status === "PROVISIONING") {
    const failed = setup?.status === "FAILED";
    add(
      "setup",
      <Banner
        tone={failed ? "danger" : "info"}
        title={failed ? "Setup failed" : "Being set up"}
        icon={failed ? undefined : <LoaderCircle className="h-4 w-4 animate-spin" />}
        action={
          <>
            {!failed && <AutoRefresh seconds={10} />}
            {toTab("operations", failed ? "Open Operations" : "See the job")}
          </>
        }
      >
        {setup ? (
          <>
            {`Step: ${setup.step || "waiting to start"}`}
            {setup.attempts > 1 && ` · attempt ${setup.attempts}`}
            {failed && setup.error && <span className="mt-1 block break-words">{firstLine(setup.error)}</span>}
          </>
        ) : (
          "Its database is being prepared. This page follows along."
        )}
      </Banner>,
    );
  }

  if (active && !tenant.isDefault) {
    if (standing.kind === "past-due") {
      add(
        "past-due",
        <Banner tone="warning" title={`A payment failed — it is held on ${clock.dayMonth(standing.holdAt)} unless it is paid`} action={caps.sell ? toTab("billing", "Open Billing") : undefined}>
          {`That is ${inDays(standing.holdAt, asOf, clock)}. Paying at its gateway before then keeps it open.`}
        </Banner>,
      );
    } else if (standing.kind === "trial-over") {
      add(
        "trial-over",
        <Banner tone="warning" title={`Its trial is over — it is held on ${clock.dayMonth(standing.holdAt)} unless it buys a plan`} action={caps.sell ? toTab("billing", "Open Billing") : undefined}>
          {`That is ${inDays(standing.holdAt, asOf, clock)}. Extending the trial, or a plan given by hand, keeps it open.`}
        </Banner>,
      );
    } else if (standing.kind === "lapsed") {
      add(
        "lapsed",
        <Banner tone="warning" title={`Nothing live since ${clock.dayMonth(standing.since)}`} action={caps.sell ? toTab("billing", "Open Billing") : undefined}>
          Billing holds it at the next platform tick unless it is put on a plan.
        </Banner>,
      );
    }
  }

  if (header.exemptWhilePaying && tenant.status !== "DEPROVISIONED") {
    const gateways = [...new Set(header.gatewayPaying.map((g) => gatewayLabel(g.gateway)))].join(" and ");
    add(
      "exempt",
      <Banner tone="warning" title={`Pays through ${gateways}, and also has a plan given by hand`} action={caps.manage ? toTab("billing", "Review in Billing") : undefined}>
        While the hand-given plan is live, billing leaves it alone — a failed payment at the gateway would never hold it.
      </Banner>,
    );
  }

  if (active && header.schemaBehind && header.behindBy) {
    add(
      "behind",
      <Banner tone="warning" title={`Behind the latest schema by ${plural(header.behindBy, "migration")}`}>
        {`Its database is on ${schemaLabel(tenant.schemaVersion)}. Anything that needs a newer migration may fail for its users until it is migrated.`}
      </Banner>,
    );
  }

  if (active && standing.kind === "trial") {
    const days = clock.daysBetween(asOf, standing.endsAt);
    if (days >= 0 && days <= 7) {
      add(
        "trial",
        <Banner tone="info" title={`Trial ends ${clock.dayMonth(standing.endsAt)} (${inDays(standing.endsAt, asOf, clock)})`} action={caps.sell ? toTab("billing", "Open Billing") : undefined}>
          After that it is held unless it buys a plan{caps.sell ? " — or its trial is extended from Billing" : ""}.
        </Banner>,
      );
    }
  }

  if (banners.length === 0) return null;
  return (
    <div className="space-y-3">
      {banners.map((b) => (
        <div key={b.key}>{b.node}</div>
      ))}
    </div>
  );
}
