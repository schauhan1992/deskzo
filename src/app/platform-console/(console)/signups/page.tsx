import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck, LockOpen, Ticket } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { DateRangeFilter, SearchField } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { SignupFunnelCharts } from "@/components/console/signups/funnel";
import { StuckTable } from "@/components/console/signups/stuck-table";
import { Pagination } from "@/components/ui/pagination";
import { dayKeyLabel, plural } from "@/lib/console-shared/format";
import { SIGNUP_STAGE } from "@/lib/console-shared/labels";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { STUCK_STAGES, parseSignupFilters, withParams } from "@/lib/console-shared/params";
import { capsFor } from "@/lib/console-shared/roles";
import { consoleStaff } from "@/lib/platform/console-page";
import { signupOpen } from "@/lib/platform/settings";
import { signupFunnel, stuckSignups } from "@/lib/platform/signups";

export const metadata: Metadata = { title: "Signups" };

const PATH = "/signups";

/**
 * Signups (spec §3.6): how far people get between starting to sign up and paying, over a range of
 * India's days (the last 30 unless one is picked), and the ones who got stuck on the way — for staff
 * to follow up with. Owners, admins, support and billing may open it; only managers see the address
 * a signup came from, and for everybody else the loader does not read it at all. Nothing here
 * changes anything.
 */
export default async function ConsoleSignupsPage({ searchParams }: PageProps<"/platform-console/signups">) {
  const staff = await consoleStaff(PAGE_ROLES.signups);
  const caps = capsFor(staff.role);
  const sp = await searchParams;
  const f = parseSignupFilters(sp);
  const [funnel, stuck, open] = await Promise.all([
    signupFunnel({ from: f.from, to: f.to }),
    stuckSignups({ stage: f.stage, q: f.q, page: f.page, withIp: caps.viewSignupIp }),
    signupOpen(),
  ]);

  const picked = Boolean(f.from || f.to);
  const subtitle = `${dayKeyLabel(funnel.from)} – ${dayKeyLabel(funnel.to)}${picked ? "" : " (the last 30 days)"} · ${plural(funnel.started, "signup")} started`;

  const modePill = (
    <StatusPill tone={open ? "success" : "neutral"} icon={open ? <LockOpen className="h-3 w-3" /> : <Ticket className="h-3 w-3" />}>
      {open ? "Signup: open" : "Signup: invite-only"}
    </StatusPill>
  );

  const stuckTotal = STUCK_STAGES.reduce((sum, s) => sum + stuck.counts[s], 0);
  const narrowed = Boolean(f.q || f.stage);
  const clearHref = withParams(PATH, sp, { q: null, stage: null });
  const totalPages = Math.max(1, Math.ceil(stuck.total / stuck.pageSize));

  return (
    <>
      <PageHeader
        title="Signups"
        chips={
          caps.viewSettings ? (
            <Link href="/settings#signup" title="Signup settings" className="rounded-full hover:opacity-80">
              {modePill}
            </Link>
          ) : (
            modePill
          )
        }
        subtitle={subtitle}
        actions={<DateRangeFilter label="Started" />}
      />

      <div className="space-y-6">
        <SignupFunnelCharts funnel={funnel} />

        <section aria-label="Stuck signups">
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-text">Stuck signups</h2>
            <p className="mt-0.5 text-xs text-muted">
              People who began and did not get through, whatever the dates above: codes that ran out this week, setups stuck now, and workspaces
              nobody has signed in to for up to 30 days.
            </p>
          </div>

          <FilterBar trailing={<SearchField label="Search stuck signups" placeholder="Email, company, name or address" />}>
            <ViewTabs
              label="Stuck stage"
              items={[
                { key: "all", label: "All", href: withParams(PATH, sp, { stage: null }), active: !f.stage, count: stuckTotal },
                ...STUCK_STAGES.map((stage) => ({
                  key: stage,
                  label: SIGNUP_STAGE[stage].label,
                  href: withParams(PATH, sp, { stage }),
                  active: f.stage === stage,
                  count: stuck.counts[stage],
                })),
              ]}
            />
          </FilterBar>

          {stuck.rows.length > 0 ? (
            <>
              <Panel padded={false}>
                <StuckTable rows={stuck.rows} showIp={caps.viewSignupIp} />
              </Panel>
              {totalPages > 1 && (
                <Pagination page={stuck.page} pageSize={stuck.pageSize} total={stuck.total} totalPages={totalPages} pageSizes={[stuck.pageSize]} label="signups" />
              )}
            </>
          ) : (
            <Panel padded={false}>
              {narrowed ? (
                <EmptyState variant="filtered" title="No stuck signup matches." body="Try another stage, or search by another detail." clearHref={clearHref} />
              ) : (
                <EmptyState
                  icon={<CircleCheck className="h-5 w-5" />}
                  title="Nobody is stuck."
                  body="Signups whose code ran out, whose setup stalled, or whose owner never signed in to the new workspace are listed here."
                />
              )}
            </Panel>
          )}
        </section>
      </div>
    </>
  );
}
