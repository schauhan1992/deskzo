import Link from "next/link";
import type { ReactNode } from "react";
import {
  getDashboardSummary,
  getDashboardWidgetOptions,
  getDashboardPreferences,
  getDashboardPresetOptions,
  setDashboardPreferences,
} from "@/actions/dashboard";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { DashboardCustomizeButton } from "@/components/dashboard/dashboard-customize-button";
import { WidgetGrid, type GridItem } from "@/components/dashboard/widget-grid";
import { Bell, Pin } from "lucide-react";
import { formatCurrency, formatDate, formatDateTime, cn } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { SCOPE_LABEL, getDashboardWidgetDefinition } from "@/lib/dashboard-widgets";
import type { ProjectHealth, ProjectStatus } from "@prisma/client";
import { projectHealthLabels, projectHealthTone, projectStatusLabels } from "@/lib/projects/status";
import { noteColorClasses } from "@/components/notes/note-card";
import type { NoteColor } from "@/lib/validation/note";
import {
  CashFlowCard,
  IncomeExpenseCard,
  OutstandingCard,
  TopExpensesCard,
} from "@/components/finance/finance-cards";
import { WelcomeHeader, type DashboardTab } from "@/components/dashboard/welcome-header";
import { GettingStarted } from "@/components/dashboard/getting-started";
import { RecentUpdates } from "@/components/help/recent-updates";
import { getGettingStarted, listUpdates, unreadUpdateCount } from "@/actions/help";
import { getSupportContact } from "@/actions/support";
import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { todaysMoments } from "@/lib/hr/today";

function StatCard({ label, value, sublabel, href }: { label: string; value: string; sublabel?: string; href: string }) {
  return (
    <Link href={href}>
      <Card className="h-full transition-colors hover:border-line-strong">
        <CardContent>
          <p className="text-sm text-muted">{label}</p>
          <p className="mt-1 text-2xl font-semibold text-text">{value}</p>
          {sublabel && <p className="mt-1 text-xs text-muted">{sublabel}</p>}
        </CardContent>
      </Card>
    </Link>
  );
}

/** The shell every list widget shares, so a new one is a body rather than a layout. */
function ListCard({
  title,
  href,
  linkLabel = "View all",
  children,
}: {
  title: string;
  href: string;
  linkLabel?: string;
  children: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        <Link href={href} className="text-xs font-medium text-muted hover:text-text hover:underline">
          {linkLabel}
        </Link>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-subtle">{children}</p>;
}

/**
 * A target, its progress, and whether that progress is good.
 *
 * The bar carries two marks, not one. The filled portion is what has been achieved; the notch is
 * where the month has got to. A bar at 60% means nothing on its own — on the 12th it is excellent
 * and on the 28th it is a problem — so the comparison is drawn rather than left to be worked out.
 */
function TargetCard({
  target,
}: {
  target: NonNullable<Awaited<ReturnType<typeof getDashboardSummary>>["salesTarget"]>;
}) {
  // The four `judge()` returns in src/lib/targets/metrics.ts, matched exactly. Guessing at these
  // names is silent when it is wrong — every bar simply comes out the default colour and nothing
  // says the status was never being read.
  const BAR: Record<string, string> = { green: "bg-success", amber: "bg-warning", red: "bg-danger", default: "bg-brand" };
  const TEXT: Record<string, string> = { green: "text-success", amber: "text-warning", red: "text-danger", default: "text-muted" };
  const tone = BAR[target.tone] ?? BAR.default;
  const text = TEXT[target.tone] ?? TEXT.default;


  return (
    <Link href="/targets/mine">
      <Card className="h-full transition-colors hover:border-line-strong">
        <CardContent>
          <p className="flex items-center justify-between gap-2 text-sm text-muted">
            <span className="truncate">Monthly sales target</span>
            <span className={cn("shrink-0 text-xs font-medium", text)}>{target.status}</span>
          </p>
          <p className="mt-1 text-2xl font-semibold text-text">{formatCurrency(target.achieved)}</p>

          <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div className={cn("h-full rounded-full", tone)} style={{ width: `${Math.min(100, target.percent)}%` }} />
            {/* Where the month has reached, so the bar above can be read against something. */}
            <span
              className="absolute top-0 h-full w-px bg-text/40"
              style={{ left: `${Math.min(100, target.elapsedPercent)}%` }}
              aria-hidden
            />
          </div>

          <p className="mt-1.5 text-xs text-muted">
            {target.percent}% of {formatCurrency(target.target)} · {target.metricLabel}
            {target.daysLeft > 0 ? ` · ${target.daysLeft} days left` : " · last day"}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

const TABS: DashboardTab[] = [
  { key: "overview", label: "Dashboard" },
  { key: "getting-started", label: "Getting Started" },
  { key: "updates", label: "Recent Updates" },
];

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = TABS.some((t) => t.key === requested) ? requested! : "overview";

  // The band across the top is the same on every tab: the greeting (which resolves the name itself,
  // from todaysMoments()), the company, and the helpline.
  const user = await requireUser();
  const [today, branding, organisation, helpDesk, unread, canManageHelp] = await Promise.all([
    todaysMoments(),
    getBranding(),
    getOrganisation(),
    // The platform's support desk, from the console — not a helpline each workspace sets for itself.
    getSupportContact(),
    unreadUpdateCount(),
    can(user.id, "help.manage"),
  ]);
  const companyName = organisation.tradeName || organisation.legalName || branding.appName;
  const header = (actions?: ReactNode) => (
    <WelcomeHeader
      greeting={today.greeting}
      moments={today.moments}
      companyName={companyName}
      logoDataUrl={branding.logoDataUrl}
      helpDesk={helpDesk}
      // The count is only worth showing until they open the tab that clears it.
      tabs={TABS.map((t) => (t.key === "updates" && tab !== "updates" ? { ...t, badge: unread } : t))}
      activeTab={tab}
      actions={actions}
    />
  );

  // The other two tabs return before a single widget is computed — the dashboard's own queries are
  // the expensive part of this page, and neither tab shows any of them.
  if (tab === "getting-started") {
    return (
      <div>
        {header()}
        <GettingStarted steps={await getGettingStarted()} />
      </div>
    );
  }
  if (tab === "updates") {
    return (
      <div>
        {header()}
        <RecentUpdates posts={await listUpdates()} canManage={canManageHelp} />
      </div>
    );
  }

  const [summary, widgetOptions, prefs, presets] = await Promise.all([
    getDashboardSummary(),
    getDashboardWidgetOptions(),
    getDashboardPreferences(),
    getDashboardPresetOptions(),
  ]);

  const availableKeys = new Set(widgetOptions.map((w) => w.key));
  // An array, not a set. The order *is* the preference now — somebody who drags Outstanding balance
  // to the top has said something, and a Set would throw it away on the next render. Uncustomised
  // still means "the set for your role" rather than everything they may open, intersected with what
  // is available so a role default for a switched-off module stays hidden.
  const visibleKeys = (prefs.customized ? prefs.widgets : prefs.defaults).filter((k) => availableKeys.has(k));

  /**
   * Every widget this person could be shown, by key.
   *
   * Built as a map rather than laid out in place, because the arrangement belongs to them now. A
   * widget whose data came back null — a module switched off, a figure they may not see — simply
   * has no entry here, and drops out below without needing a second condition anywhere.
   */
  const widgets: Record<string, ReactNode> = {};

  widgets.companies = (
    <StatCard
      label="Companies"
      value={String(summary.companies.total)}
      sublabel={`${summary.companies.prospects} prospects · ${summary.companies.leads} leads · ${summary.companies.awaitingOrder} awaiting order`}
      href="/companies"
    />
  );

  widgets.customers = (
    <StatCard
      label="Customers"
      value={String(summary.customers.total)}
      sublabel="Have purchased at least once"
      href="/customers"
    />
  );

  const leadSummary = summary.leads;
  if (leadSummary) {
    widgets.leads = (
      <StatCard
        label="Open leads"
        value={String(leadSummary.open)}
        // Says whose pipeline this is. Without it, two people comparing home screens and seeing
        // different totals conclude the app is broken rather than that one of them is looking at
        // their own team.
        sublabel={`${formatCurrency(leadSummary.pipelineValue)} in open pipeline · ${SCOPE_LABEL[summary.scopes.leads]}`}
        href="/leads"
      />
    );
  }

  if (summary.vendors) {
    widgets.vendors = (
      <StatCard
        label="Vendors onboarding"
        value={String(summary.vendors.onboarding)}
        sublabel={`${summary.vendors.active} active · ${summary.vendors.inactive} inactive`}
        href="/vendors"
      />
    );
  }

  if (summary.renewals) {
    widgets.renewals = (
      <StatCard
        label="Renewals expiring in 30 days"
        value={String(summary.renewals.next30)}
        sublabel={summary.renewals.expired > 0 ? `${summary.renewals.expired} already expired` : "None expired"}
        href="/renewals"
      />
    );
  }

  if (summary.payments) {
    widgets.payments = (
      <StatCard
        label="Outstanding balance"
        value={formatCurrency(summary.payments.outstandingBalance)}
        sublabel={`${summary.payments.unpaidCount} unpaid · ${summary.payments.partialCount} partially paid`}
        href="/payments"
      />
    );
  }

  if (summary.tickets) {
    widgets.tickets = (
      <StatCard
        label="Open tickets"
        value={String(summary.tickets.open)}
        sublabel={summary.tickets.overdue > 0 ? `${summary.tickets.overdue} overdue` : "None overdue"}
        href="/tickets"
      />
    );
  }

  if (summary.tasks) {
    widgets.tasks = (
      <StatCard
        label="My open tasks"
        value={String(summary.tasks.myOpen)}
        sublabel={summary.tasks.myOverdue > 0 ? `${summary.tasks.myOverdue} overdue` : "None overdue"}
        href="/tasks"
      />
    );
  }

  if (summary.quotations) {
    const quotes = summary.quotations;
    widgets.quotations = (
      <StatCard
        label="Pending quotations"
        value={String(quotes.pending)}
        sublabel={
          quotes.pending === 0
            ? "Nothing awaiting an answer"
            : `${formatCurrency(quotes.value)} quoted${quotes.lapsed > 0 ? ` · ${quotes.lapsed} past validity` : ""}`
        }
        href="/sales/proposals"
      />
    );
  }

  // Rendered even with no target set, rather than vanishing: somebody who has ticked this in
  // Customize and sees nothing cannot tell a missing target from a broken widget.
  widgets.salesTarget = summary.salesTarget ? (
    <TargetCard target={summary.salesTarget} />
  ) : (
    <Link href="/targets/mine">
      <Card className="h-full transition-colors hover:border-line-strong">
        <CardContent>
          <p className="text-sm text-muted">Monthly sales target</p>
          <p className="mt-1 text-sm text-subtle">No target set for this month.</p>
        </CardContent>
      </Card>
    </Link>
  );

  if (summary.expenses) {
    const expenses = summary.expenses;
    widgets.expenses = (
      <StatCard
        label="Expenses awaiting you"
        value={String(expenses.awaitingMe)}
        sublabel={
          expenses.myUnreimbursed > 0
            ? `${expenses.myUnreimbursed} of yours approved, not yet paid`
            : "Nothing of yours outstanding"
        }
        href="/expenses"
      />
    );
  }

  if (summary.orders) {
    const orders = summary.orders;
    widgets.orders = (
      <StatCard
        label="Orders needing action"
        value={String(orders.awaitingApproval)}
        sublabel={`${orders.awaitingSourcing} approved, awaiting sourcing`}
        href="/orders"
      />
    );
  }

  if (summary.finance) {
    const f = summary.finance;
    widgets.incomeExpense = <IncomeExpenseCard initial={f.incomeExpense} periodLabel={f.fiscalLabel} />;
    widgets.topExpenses = <TopExpensesCard initial={f.topExpenses} periodLabel={f.fiscalLabel} />;
    widgets.cashFlow = <CashFlowCard initial={f.cashFlow} from={f.cashFrom} to={f.cashTo} />;
    widgets.receivables = (
      <OutstandingCard
        title="Total receivables"
        subtitle="Total unpaid invoices"
        data={f.receivables}
        href="/receivables"
        newHref="/documents/new?type=INVOICE"
        newLabel="New"
      />
    );
    widgets.payables = (
      <OutstandingCard
        title="Total payables"
        subtitle="Total unpaid bills"
        data={f.payables}
        href="/payables"
        newHref="/purchase/bills"
        newLabel="New"
      />
    );
  }

  if (leadSummary) widgets.recentLeads = (
    <ListCard title="Recently updated leads" href="/leads">
      {leadSummary.recent.length === 0 ? (
        <Empty>No leads yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {leadSummary.recent.map((lead) => (
            <li key={lead.id} className="flex items-center justify-between px-5 py-3">
              <div className="min-w-0">
                <Link href={`/leads/${lead.id}`} className="truncate text-sm font-medium text-text hover:underline">
                  {lead.title}
                </Link>
                <p className="truncate text-xs text-muted">{lead.companyName}</p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {lead.estimatedValue !== null && (
                  <span className="text-xs text-muted">{formatCurrency(lead.estimatedValue)}</span>
                )}
                <Badge>{lead.status.replaceAll("_", " ")}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </ListCard>
  );

  if (summary.renewals) {
    const upcoming = summary.renewals.upcoming;
    widgets.upcomingRenewals = (
      <ListCard title="Upcoming renewals (next 30 days)" href="/renewals">
        {upcoming.length === 0 ? (
          <Empty>Nothing expiring in the next 30 days.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-5 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/companies/${r.companyId}?tab=renewals`}
                    className="truncate text-sm font-medium text-text hover:underline"
                  >
                    {r.companyName}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    {r.itemName} · {formatOrderId(r.orderSeq)}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted">{formatDate(r.endDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </ListCard>
    );
  }

  if (summary.projects) {
    const projects = summary.projects;

    widgets.projectsAtRisk = (
      <StatCard
        label="Projects needing attention"
        value={String(projects.needingAttention)}
        sublabel={`of ${projects.active} live · ${SCOPE_LABEL.own}`}
        href="/projects?health=AT_RISK"
      />
    );

    widgets.myProjects = (
      <ListCard title="My projects" href="/projects">
        {projects.items.length === 0 ? (
          <Empty>You&apos;re not on any live projects.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {projects.items.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <Link href={`/projects/${p.id}`} className="truncate text-sm font-medium text-text hover:underline">
                    {p.name}
                  </Link>
                  <p className="truncate text-xs text-muted">
                    {p.companyName} · {projectStatusLabels[p.status as ProjectStatus]}
                    {/* Said on the card rather than left to be found by opening it — a home
                        screen earns its place by surfacing the thing you would otherwise miss. */}
                    {p.lateDays !== null && <span className="text-danger"> · {p.lateDays}d late</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {p.health !== "ON_TRACK" && (
                    <Badge tone={projectHealthTone[p.health as ProjectHealth]}>
                      {projectHealthLabels[p.health as ProjectHealth]}
                    </Badge>
                  )}
                  {p.total > 0 && (
                    <span className="text-xs text-muted">
                      {p.done}/{p.total}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </ListCard>
    );
  }

  if (summary.notes) {
    const notes = summary.notes;
    widgets.notes = (
      <ListCard
        title="Sticky notes"
        href="/notes"
        linkLabel={notes.total > notes.items.length ? `View all ${notes.total}` : "View all"}
      >
        {notes.items.length === 0 ? (
          <Empty>
            Nothing on your board.{" "}
            <Link href="/notes" className="text-muted hover:text-text hover:underline">
              Write one
            </Link>
            .
          </Empty>
        ) : (
          // A grid rather than the divided list the other cards use: these are notes, and the colour
          // somebody chose is half of how they find the right one again.
          <div className="grid grid-cols-1 gap-2 px-5 pb-5 pt-1 sm:grid-cols-2">
            {notes.items.map((note) => (
              <Link
                key={note.id}
                href="/notes"
                className={cn(
                  "flex min-h-[72px] flex-col gap-1 rounded-base border px-3 py-2 transition-opacity hover:opacity-90",
                  noteColorClasses[note.color as NoteColor],
                )}
              >
                <span className="flex items-start gap-1.5">
                  {note.pinned && <Pin className="mt-0.5 h-3 w-3 shrink-0 text-text/60" />}
                  {/* A reminder that has come due, on the screen somebody opens first. */}
                  {note.remindDue && <Bell className="mt-0.5 h-3 w-3 shrink-0 text-warning" />}
                  {note.title && <span className="line-clamp-1 text-xs font-semibold text-text">{note.title}</span>}
                </span>
                <span className="line-clamp-3 whitespace-pre-line text-xs text-text/80">{note.body}</span>
                {/* Only on somebody else's note. On your own it would be your own name on every
                    card, which tells you nothing and costs a line. */}
                {!note.mine && <span className="mt-auto truncate text-[11px] text-text/50">{note.ownerName}</span>}
              </Link>
            ))}
          </div>
        )}
      </ListCard>
    );
  }

  widgets.activity = (
    <ListCard title="Latest activity" href="/activity">
      {summary.activity.items.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {summary.activity.items.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-3 px-5 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm text-text">{row.summary}</p>
                <p className="truncate text-xs text-muted">
                  {/* A system-raised row has no person behind it, and an em dash there would read as
                      a missing name rather than as nobody's doing. */}
                  {row.userName ?? "System"} · {row.kind.replaceAll("_", " ").toLowerCase()}
                </p>
              </div>
              <span className="shrink-0 text-xs text-subtle">{formatDateTime(row.at)}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Said on the card, because a log showing five of your own actions looks identical to one
          showing five of everybody's when you happen to be the only person working. */}
      {summary.activity.ownOnly && summary.activity.items.length > 0 && (
        <p className="border-t border-line px-5 py-2 text-xs text-subtle">Your own activity.</p>
      )}
    </ListCard>
  );

  const items: GridItem[] = visibleKeys
    .filter((key) => Boolean(widgets[key]))
    .map((key) => {
      const def = getDashboardWidgetDefinition(key);
      return { key, label: def?.label ?? key, size: def?.size ?? "stat", node: widgets[key] };
    });

  return (
    <div>
      {/* The greeting knows the time of day and who has a birthday; the splash for anything bigger is
          mounted in the layout, so it reaches every page. */}
      {header(
        <DashboardCustomizeButton
          options={widgetOptions}
          selected={visibleKeys}
          customized={prefs.customized}
          presets={presets}
        />,
      )}

      {items.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="py-8 text-center text-sm text-muted">
            Your dashboard is empty — click Customize to choose what to show.
          </CardContent>
        </Card>
      ) : (
        // The dashboard saves order and selection together, because ticking a widget off in
        // Customize and dragging one are the same array here.
        <WidgetGrid items={items} onReorder={setDashboardPreferences} />
      )}
    </div>
  );
}
