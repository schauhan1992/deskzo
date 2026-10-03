import Link from "next/link";
import { listCollections, type CollectionsFilter } from "@/actions/collections";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice, NoAccessNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { FollowUpHistory, PromiseBadge, promiseText } from "@/components/collections/follow-up-history";
import { LogFollowUpButton } from "@/components/collections/log-follow-up-button";
import { formatCurrency } from "@/lib/utils";
import { formatMoney, isBaseCurrency } from "@/lib/currency";
import { AGING_BUCKETS } from "@/lib/receivables";
import { followUpChannelLabels, longDay, shortDay, daysBetween } from "@/lib/collections/rules";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { companyPath } from "@/lib/record-links";

const FILTERS: { value: CollectionsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "broken", label: "Promise broken" },
  { value: "week", label: "Promised this week" },
  { value: "stale", label: "No follow-up in 14 days" },
];

const BUCKET_LABEL = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, b.label])) as Record<(typeof AGING_BUCKETS)[number]["key"], string>;

/**
 * My collections: what the viewer's clients owe — the accounts they manage (their team's, for a
 * manager) and the orders they punched on anybody's — grouped by client, with the last follow-up, the
 * promise and the next follow-up on each, and a Log follow-up on every row. See src/actions/collections.ts.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; sort?: string }>;
}) {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;
  const params = await searchParams;
  const data = await listCollections({ filter: params.filter, q: params.q, sort: params.sort });
  if (!data) return <NoAccessNotice title="My collections" permission="collections.followUp" />;

  // Today on the workspace's calendar, as a date column holds a day.
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  const query = (overrides: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries({ filter: data.filter === "all" ? undefined : data.filter, q: params.q, sort: data.sort === "overdue" ? undefined : data.sort, ...overrides }).filter(([, v]) => v),
    ) as Record<string, string>;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">My collections</h1>
        <p className="mt-1 text-sm text-muted">
          {data.restricted
            ? "What your clients owe: the accounts you manage (and your team's), and orders you punched on anybody's account."
            : "What every client owes."}{" "}
          Log each follow-up — what they said, and the date they promise to pay by. A promise that passes unpaid is flagged to
          you, your manager and accounts.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Total pending" value={formatCurrency(data.tiles.pending)} hint={`${data.tiles.pendingCount} invoice(s) and order(s)`} />
        <Tile
          label="Overdue"
          value={formatCurrency(data.tiles.overdue)}
          hint={`${data.tiles.overdueCount} past the due date`}
          tone={data.tiles.overdue > 0 ? "danger" : undefined}
        />
        <Tile
          label="Promised this week"
          value={formatCurrency(data.tiles.promisedWeek)}
          hint={`${data.tiles.promisedWeekCount} promise(s), ${shortDay(data.week.from)} – ${shortDay(data.week.to)}`}
        />
        <Tile
          label="Broken promises"
          value={String(data.tiles.brokenCount)}
          hint={data.tiles.brokenCount > 0 ? `${formatCurrency(data.tiles.broken)} promised, not received` : "none"}
          tone={data.tiles.brokenCount > 0 ? "danger" : undefined}
        />
      </div>
      <p className="mt-2 text-xs text-subtle">Totals in ₹ — an invoice in another currency at its own rate.</p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search client name…" />
        <nav aria-label="Filter dues" className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={{ pathname: "/collections", query: query({ filter: f.value === "all" ? undefined : f.value }) }}
              aria-current={data.filter === f.value ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm ${
                data.filter === f.value ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Sort" className="ml-auto flex items-center gap-2 text-sm text-muted">
          <span>Sort:</span>
          <Link
            href={{ pathname: "/collections", query: query({ sort: undefined }) }}
            aria-current={data.sort === "overdue" ? "page" : undefined}
            className={data.sort === "overdue" ? "font-medium text-text underline" : "hover:text-text"}
          >
            Most overdue
          </Link>
          <Link
            href={{ pathname: "/collections", query: query({ sort: "amount" }) }}
            aria-current={data.sort === "amount" ? "page" : undefined}
            className={data.sort === "amount" ? "font-medium text-text underline" : "hover:text-text"}
          >
            Largest amount
          </Link>
        </nav>
      </div>

      <div className="mt-5 space-y-4">
        {data.groups.length === 0 && (
          <Card className="px-4 py-10 text-center text-sm text-subtle">
            {data.filter === "all" && !params.q ? "Nothing is owed on your accounts. Every invoice and order is paid." : "Nothing matches."}
          </Card>
        )}
        {data.groups.map((group) => (
          <Card key={group.companyId} className="overflow-x-auto p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
              <div>
                {group.onTheirAccount ? (
                  <Link href={`${companyPath(group.companySeq)}?tab=statement`} className="font-medium text-text hover:underline">
                    {group.companyName}
                  </Link>
                ) : (
                  <span className="font-medium text-text">{group.companyName}</span>
                )}
                <span className="ml-2 text-xs text-subtle">
                  {group.ownerName ? `Account manager: ${group.ownerName}` : "No account manager"}
                </span>
              </div>
              <div className="text-sm font-semibold text-text">{formatCurrency(group.total)}</div>
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Invoice / order</th>
                  <th className="px-3 py-2">Due</th>
                  <th className="px-3 py-2 text-right">Outstanding</th>
                  <th className="px-3 py-2">Last follow-up</th>
                  <th className="px-3 py-2">Promise</th>
                  <th className="px-3 py-2">Next follow-up</th>
                  <th className="px-4 py-2 text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => {
                  // An order's label is its ORD- reference, which is the order page's own address.
                  const href = row.onTheirAccount ? (row.kind === "invoice" ? `/documents/${row.id}` : `/orders/${row.label}`) : null;
                  const next = row.nextFollowUpOn ? new Date(`${row.nextFollowUpOn}T00:00:00Z`) : null;
                  const nextIn = next ? daysBetween(today, next) : null;
                  return (
                    <tr key={row.key} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5">
                        {href ? (
                          <Link href={href} className="font-mono text-xs text-text hover:underline">
                            {row.label}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs text-text">{row.label}</span>
                        )}
                        <div className="mt-0.5 text-xs text-subtle">
                          {row.kind === "order" ? "Order — not invoiced yet" : "Tax invoice"}
                          {!row.onTheirAccount && row.punchedBy ? ` · punched by ${row.punchedBy}` : ""}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        {/* An invoice's due date is a typed day (midnight UTC); an order's, the moment its terms run out. */}
                        <div className="text-muted">{row.kind === "invoice" ? formatCalendarDay(row.dueOn) : clock.date(row.dueOn)}</div>
                        {row.daysOverdue > 0 ? (
                          <Badge tone={row.daysOverdue > 90 ? "red" : "amber"}>
                            {row.daysOverdue}d overdue · {BUCKET_LABEL[row.bucket]}
                          </Badge>
                        ) : (
                          <Badge tone="default">Not yet due</Badge>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        <div className="font-medium text-text">{formatMoney(row.balance, row.currency)}</div>
                        {!isBaseCurrency(row.currency) && <div className="text-xs text-subtle">≈ {formatCurrency(row.balanceInr)}</div>}
                      </td>
                      <td className="min-w-56 px-3 py-2.5 text-xs">
                        {row.lastFollowUp ? (
                          <>
                            <div className="text-muted">
                              <span className="text-text">{clock.date(row.lastFollowUp.createdAt)}</span> ·{" "}
                              {followUpChannelLabels[row.lastFollowUp.channel]}
                              {row.lastFollowUp.byName ? ` · ${row.lastFollowUp.byName}` : ""}
                            </div>
                            <p className="mt-0.5 line-clamp-2 break-words text-text">{row.lastFollowUp.remarks}</p>
                            {row.stale && <Badge tone="amber">No follow-up in {data.staleDays} days</Badge>}
                            {row.history.length > 1 && (
                              <details className="mt-1">
                                <summary className="cursor-pointer text-muted hover:text-text">All {row.history.length} follow-ups</summary>
                                <div className="mt-2">
                                  <FollowUpHistory history={row.history} showTarget={row.history.some((h) => h.targetLabel !== row.label)} />
                                </div>
                              </details>
                            )}
                          </>
                        ) : (
                          <Badge tone="amber">Never followed up</Badge>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {row.promise ? (
                          <div className="space-y-1">
                            <div className="text-muted">{promiseText(row.promise)}</div>
                            <PromiseBadge view={row.promise} />
                          </div>
                        ) : (
                          <span className="text-subtle">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                        {next && nextIn !== null ? (
                          <>
                            <div className="text-muted">{longDay(next)}</div>
                            {nextIn < 0 ? (
                              <Badge tone="red">Missed</Badge>
                            ) : nextIn === 0 ? (
                              <Badge tone="amber">Today</Badge>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-subtle">Not planned</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <LogFollowUpButton
                          target={{
                            ...(row.kind === "invoice" ? { documentId: row.id } : { companyProductId: row.id }),
                            label: row.label,
                            companyName: row.companyName,
                            balance: row.balance,
                            currency: row.currency,
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "danger" }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "danger" ? "text-danger" : "text-text"}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
