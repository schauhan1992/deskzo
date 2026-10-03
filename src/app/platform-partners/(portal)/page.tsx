import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { BadgeCheck, Building2, CircleCheck, HandCoins, Hourglass, Network, ReceiptText, TrendingUp, UserPlus, Wallet } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { MoneyList } from "@/components/console/charts/money-list";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { PortalPage } from "@/components/partners/common/page";
import { LatestCustomersPanel, RenewalsPanel, SetupChecklist, TrialsEndingPanel } from "@/components/partners/dashboard/dashboard-panels";
import { formatMoney } from "@/lib/billing/money";
import { plural } from "@/lib/console-shared/format";
import { partnerPage } from "@/lib/partners/guard";
import { PARTNER_PAGE_ROLES, PARTNER_ROUTES, canOpenPartnerPage } from "@/lib/partners/nav";
import { portalDashboard } from "@/lib/partners/portal-data";
import { consoleClock } from "@/lib/platform/console-clock";

export const metadata: Metadata = { title: "Dashboard" };

const num = (n: number) => n.toLocaleString("en-IN");
const LINK = "inline-flex h-8 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium text-text shadow-sm hover:bg-surface-sunken";

/**
 * The partner portal's home (`/`, every role): how many customers are credited to the partner now,
 * how many pay, how many are on a trial, what they bring in a month at list prices (per currency,
 * never added across currencies) and how many came this month; then what is coming up — trials
 * ending, renewals and cancellations — and the newest customers.
 *
 * The money roles (admin, finance) also see the commission tiles; for everyone else the loader reads
 * no commission at all, and nothing here mentions it. A distributor sees its resellers. While the
 * partner account is being set up, a checklist leads the page.
 *
 * "This month" is India's, as the statements' months are (src/lib/partners/statements.ts); the dates in
 * the lists are the console's clock's (Settings › Time zone), as every time the portal shows.
 */
export default async function PartnerDashboardPage() {
  const session = await partnerPage(PARTNER_PAGE_ROLES.dashboard);
  const me = session.user;
  const now = new Date();
  const [d, clock] = await Promise.all([portalDashboard(me, now), consoleClock()]);
  const canOpen = (key: Parameters<typeof canOpenPartnerPage>[2]) => canOpenPartnerPage(me.role, me.partner.kind, key);
  const c = d.customers;
  const trouble = [c.held > 0 ? `${num(c.held)} held` : null, c.pastDue > 0 ? `${num(c.pastDue)} past due` : null].filter(Boolean).join(" · ");

  // The second row: commission (money roles), then resellers (distributors).
  const more: ReactNode[] = [];
  if (d.money) {
    more.push(
      <KpiTile
        key="this-month"
        label="Commission this month"
        value={<MoneyList amounts={d.money.thisMonth} />}
        icon={<HandCoins className="h-4 w-4" />}
        href={PARTNER_ROUTES.commissions}
        secondary="Earned since the 1st (India time), net of clawbacks"
      />,
      <KpiTile
        key="awaiting"
        label="Awaiting statement"
        value={<MoneyList amounts={d.money.awaitingStatement} />}
        icon={<ReceiptText className="h-4 w-4" />}
        href={`${PARTNER_ROUTES.commissions}?status=PENDING`}
        secondary="Goes on next month's statement"
      />,
      <KpiTile
        key="approved"
        label="Approved to pay"
        value={<MoneyList amounts={d.money.approvedToPay} />}
        icon={<Wallet className="h-4 w-4" />}
        href={canOpen("statements") ? PARTNER_ROUTES.statements : undefined}
        secondary="On an approved statement, to be paid"
      />,
    );
  }
  if (d.resellers) {
    const mrr = d.resellers.mrr.map((m) => formatMoney(m.minor, m.currency)).join(" · ");
    more.push(
      <KpiTile
        key="resellers"
        label="Resellers"
        value={num(d.resellers.count)}
        icon={<Network className="h-4 w-4" />}
        href={canOpen("resellers") ? PARTNER_ROUTES.resellers : undefined}
        secondary={mrr ? `Their customers' MRR: ${mrr}` : "No MRR from their customers yet"}
      />,
    );
  }

  const invitationsLink = canOpen("invitations") ? (
    <Link href={PARTNER_ROUTES.invitations} className={LINK}>
      Go to Invitations
    </Link>
  ) : undefined;

  return (
    <PortalPage title="Dashboard" subtitle={`Customers credited to ${me.partner.displayName}, what they bring in, and what is coming up.`} asOf={d.asOf}>
      {d.setup && <SetupChecklist setup={d.setup} teamHref={canOpen("team") ? `${PARTNER_ROUTES.team}?invite=1` : null} profileHref={PARTNER_ROUTES.profile} />}

      <KpiGrid columns={5}>
        <KpiTile label="Customers" value={num(c.total)} icon={<Building2 className="h-4 w-4" />} href={PARTNER_ROUTES.customers} secondary={trouble || "None held or past due"} />
        <KpiTile label="Active" value={num(c.active)} icon={<CircleCheck className="h-4 w-4" />} secondary="Paying, and paid up" />
        <KpiTile
          label="On trial"
          value={num(c.trial)}
          icon={<Hourglass className="h-4 w-4" />}
          href={`${PARTNER_ROUTES.customers}?standing=trial`}
          secondary={d.trialsEnding.length > 0 ? `${plural(d.trialsEnding.length, "trial")} ending in 14 days` : "None ending in 14 days"}
        />
        <KpiTile label="Attributed MRR" value={<MoneyList amounts={d.mrr} />} icon={<TrendingUp className="h-4 w-4" />} secondary="At list prices, per currency" />
        <KpiTile label="New this month" value={num(c.newThisMonth)} icon={<UserPlus className="h-4 w-4" />} secondary="Credited since the 1st (India time)" />
      </KpiGrid>

      {more.length > 0 && <KpiGrid columns={more.length === 2 ? 2 : more.length === 3 ? 3 : 4}>{more}</KpiGrid>}

      {c.total === 0 ? (
        <Panel>
          <EmptyState
            icon={<BadgeCheck className="h-5 w-5" />}
            title="No customers yet"
            body="Share an invitation code or your referral link to bring your first customer. Every workspace signed up with one is credited to you."
            action={invitationsLink}
          />
        </Panel>
      ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          <TrialsEndingPanel rows={d.trialsEnding} asOf={d.asOf} clock={clock} />
          <RenewalsPanel rows={d.renewals} asOf={d.asOf} clock={clock} />
          <LatestCustomersPanel rows={d.latest} action={invitationsLink} clock={clock} />
        </div>
      )}
    </PortalPage>
  );
}
