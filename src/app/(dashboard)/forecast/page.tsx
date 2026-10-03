import Link, { type LinkProps } from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { getCommits, getForecast } from "@/actions/forecast";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { PersonParamFilter } from "@/components/ui/person-param-filter";
import { ForecastChart, compactInr } from "@/components/forecast/forecast-chart";
import { StageWeights } from "@/components/forecast/stage-weights";
import { CommitsPanel } from "@/components/forecast/commits-panel";
import { AFTER, BEFORE, UNDATED } from "@/lib/forecast/periods";
import { STAGE_LABEL } from "@/lib/forecast/stages";
import { formatOrderId } from "@/lib/order-id";
import { formatCurrency, cn } from "@/lib/utils";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";

type Params = { view?: string; grain?: string; count?: string; owner?: string; period?: string };

const inr =(n: number | null | undefined) => (n === null || n === undefined ? "—" : formatCurrency(n));

const COLORS = { forecast: "#6366f1", booked: "#10b981", target: "#f59e0b", lastYear: "#94a3b8", due: "#cbd5e1" };

/**
 * The forecast, period by period. One page, five views, the same periods and the same salesperson
 * filter across all of them — so "October" means the same thing on every tab.
 */
export default async function ForecastPage({ searchParams }: { searchParams: Promise<Params> }) {
  if (!(await isModuleEnabled("forecast"))) return <ModuleDisabledNotice moduleKey="forecast" />;
  const params = await searchParams;
  const data = await getForecast({ grain: params.grain, count: params.count, ownerId: params.owner });
  if (!data) return <ModuleDisabledNotice moduleKey="forecast" />;
  // Every date the forecast hands back is a moment on the workspace's clock (a calendar day as the
  // moment it begins), so the day shown is the clock's.
  const clock = await workspaceClock();
  const d = (v: Date | string | null) => clock.date(v);

  const view = ["sales", "renewals", "collections", "amc", "commits"].includes(params.view ?? "") ? params.view! : "sales";
  const grainDef = data.grains.find((g) => g.key === data.grain)!;
  const keep = { grain: data.grain === "month" ? undefined : data.grain, count: String(data.count), owner: data.ownerId ?? undefined };
  const labels = data.periods.map((p) => p.label);
  const selected = params.period ?? null;
  const link = (period: string) => ({ pathname: "/forecast", query: { ...Object.fromEntries(Object.entries({ ...keep, view }).filter(([, v]) => v)), period } });

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Forecast</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            What is coming, period by period. Deals count at the win rate their stage has actually achieved, renewals at the rate
            their brand really renews at, and cash at each customer&apos;s own record of paying late. Before GST except
            collections, which are cash.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="inline-flex rounded-lg border border-line p-0.5">
          {data.grains.map((g) => (
            <Link
              key={g.key}
              href={{ pathname: "/forecast", query: Object.fromEntries(Object.entries({ view, grain: g.key === "month" ? undefined : g.key, owner: data.ownerId ?? undefined }).filter(([, v]) => v)) }}
              className={cn("rounded-md px-3 py-1.5 text-xs font-medium", g.key === data.grain ? "bg-brand-subtle text-brand" : "text-muted hover:text-text")}
            >
              {g.label}
            </Link>
          ))}
        </div>
        <SelectParamFilter
          paramName="count"
          label="How far ahead"
          allLabel={`${grainDef.defaultCount} ${data.grain === "year" ? "years" : `${data.grain}s`}`}
          options={grainDef.counts.filter((c) => c !== grainDef.defaultCount).map((c) => ({ value: String(c), label: `${c} ${data.grain === "year" ? (c === 1 ? "year" : "years") : `${data.grain}s`}` }))}
          resetParams={["period"]}
        />
        {data.owners.length > 1 && (
          <PersonParamFilter paramName="owner" people={data.owners} label="Salesperson" placeholder="Everybody I can see" resetParams={["period"]} />
        )}
      </div>

      <div className="mt-4">
        <TabNav
          tabs={[
            { key: "sales", label: "Sales" },
            { key: "renewals", label: "Renewals" },
            { key: "collections", label: "Collections" },
            { key: "amc", label: "Warranty → AMC" },
            { key: "commits", label: "Commits" },
          ]}
          activeKey={view}
          paramName="view"
          basePath="/forecast"
          otherParams={keep}
        />
      </div>

      <div className="mt-4 space-y-4">
        {view === "sales" && (() => {
          const b = data.sales.buckets;
          const rows = data.periods.map((p) => ({ key: p.key, label: p.label, cell: b.periods[p.key]!, booked: data.booked[p.key] ?? 0, target: data.targets[p.key] ?? null, lastYear: data.lastYear[p.key] ?? 0, commit: data.commits[p.key] ?? null }));
          const pick = selected ?? data.periods[0]!.key;
          const inBucket = data.sales.deals.filter((deal) => deal.bucket === pick).sort((a, z) => (z.weighted ?? -1) - (a.weighted ?? -1));
          return (
            <>
              <Card>
                <CardContent className="py-4">
                  <ForecastChart
                    title="Sales forecast"
                    labels={labels}
                    series={[
                      { key: "weighted", label: "Weighted forecast", color: COLORS.forecast, values: rows.map((r) => r.cell.weighted) },
                      { key: "booked", label: "Booked so far", color: COLORS.booked, values: rows.map((r) => r.booked) },
                      { key: "target", label: "Target", color: COLORS.target, values: rows.map((r) => r.target) },
                      { key: "lastYear", label: "Same period last year", color: COLORS.lastYear, values: rows.map((r) => r.lastYear) },
                    ]}
                  />
                </CardContent>
              </Card>
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[60rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">Closing in</th>
                      <th className="px-3 py-2 text-right font-medium">Deals</th>
                      <th className="px-3 py-2 text-right font-medium">Pipeline</th>
                      <th className="px-3 py-2 text-right font-medium">Best case</th>
                      <th className="px-3 py-2 text-right font-medium">In negotiation</th>
                      <th className="px-3 py-2 text-right font-medium">Weighted</th>
                      <th className="px-3 py-2 text-right font-medium">Booked so far</th>
                      <th className="px-3 py-2 text-right font-medium">Target</th>
                      <th className="px-3 py-2 text-right font-medium">Salespeople commit</th>
                      <th className="px-3 py-2 text-right font-medium">Last year</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={cn("border-b border-line", pick === r.key && "bg-brand-subtle/40")}>
                        <td className="px-3 py-2">
                          <Link href={link(r.key)} className="font-medium text-text hover:underline">
                            {r.label}
                          </Link>
                        </td>
                        <Num v={r.cell.deals} plain />
                        <Num v={r.cell.pipeline} />
                        <Num v={r.cell.bestCase} />
                        <Num v={r.cell.commit} />
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-text">{inr(r.cell.weighted)}</td>
                        <Num v={r.booked} />
                        <td className="px-3 py-2 text-right tabular-nums text-muted">
                          {inr(r.target)}
                          {r.target ? <div className="text-[11px] text-subtle">{Math.round(((r.booked + r.cell.weighted) / r.target) * 100)}% with forecast</div> : null}
                        </td>
                        <Num v={r.commit?.commit ?? null} />
                        <Num v={r.lastYear} />
                      </tr>
                    ))}
                    <OutsideRow label="Slipped — close date passed" hint="Needs a new date" cell={b.before} active={pick === BEFORE} href={link(BEFORE)} />
                    <OutsideRow label="Later" cell={b.after} active={pick === AFTER} href={link(AFTER)} />
                    <OutsideRow label="No close date" hint="Not in any period until somebody dates it" cell={b.undated} active={pick === UNDATED} href={link(UNDATED)} />
                  </tbody>
                </table>
              </Card>
              <DealList deals={inBucket} title={titleFor(pick, data.periods)} clock={clock} />
              <StageWeights weights={data.sales.weights} canManage={data.canManage} />
            </>
          );
        })()}

        {view === "renewals" && (() => {
          const b = data.renewals.buckets;
          const pick = selected ?? data.periods[0]!.key;
          const items = data.renewals.items.filter((i) => i.bucket === pick).sort((a, z) => z.value - a.value);
          const rates = data.renewals.rates;
          return (
            <>
              <Card>
                <CardContent className="py-4">
                  <ForecastChart
                    title="Renewal forecast"
                    labels={labels}
                    series={[
                      { key: "due", label: "Falling due", color: COLORS.due, values: data.periods.map((p) => b.periods[p.key]!.dueValue) },
                      { key: "expected", label: "Expected to renew", color: COLORS.forecast, values: data.periods.map((p) => b.periods[p.key]!.expected) },
                      { key: "renewed", label: "Renewed already", color: COLORS.booked, values: data.periods.map((p) => b.periods[p.key]!.renewedValue) },
                    ]}
                  />
                </CardContent>
              </Card>
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[48rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">Due in</th>
                      <th className="px-3 py-2 text-right font-medium">Subscriptions</th>
                      <th className="px-3 py-2 text-right font-medium">Value due</th>
                      <th className="px-3 py-2 text-right font-medium">Renewed</th>
                      <th className="px-3 py-2 text-right font-medium">Lost</th>
                      <th className="px-3 py-2 text-right font-medium">Still open</th>
                      <th className="px-3 py-2 text-right font-medium">Expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.periods.map((p) => ({ key: p.key, label: p.label, hint: null as string | null, cell: b.periods[p.key]! })), { key: BEFORE, label: "Lapsed in the last 90 days, not renewed", hint: "Late renewals still happen", cell: b.before }].map((r) => (
                      <tr key={r.key} className={cn("border-b border-line last:border-0", pick === r.key && "bg-brand-subtle/40")}>
                        <td className="px-3 py-2">
                          <Link href={link(r.key)} className="font-medium text-text hover:underline">
                            {r.label}
                          </Link>
                          {r.hint && <div className="text-[11px] text-subtle">{r.hint}</div>}
                        </td>
                        <Num v={r.cell.due} plain />
                        <Num v={r.cell.dueValue} />
                        <td className="px-3 py-2 text-right tabular-nums text-success">{r.cell.renewed ? `${r.cell.renewed} · ${inr(r.cell.renewedValue)}` : "—"}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-danger">{r.cell.lost ? `${r.cell.lost} · ${inr(r.cell.lostValue)}` : "—"}</td>
                        <Num v={r.cell.open} plain />
                        <td className="px-3 py-2 text-right font-semibold tabular-nums text-text">{inr(r.cell.expected)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">{titleFor(pick, data.periods, "Renewals")}</h2>
                </CardHeader>
                <CardContent className="p-0">
                  {items.length === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-subtle">Nothing falls due here.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {items.map((i) => (
                        <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                          <div className="min-w-0">
                            <Link href={`/companies/${i.company.id}?tab=renewals`} className="font-medium text-text hover:underline">
                              {i.company.name}
                            </Link>
                            <div className="text-xs text-muted">
                              {i.product} · {formatOrderId(i.ref)} · ends {d(i.endDate)}
                              {i.accountManager && ` · ${i.accountManager}`}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="tabular-nums text-text">{inr(i.value)}</span>
                            {i.incomplete && <Badge tone="amber">price missing</Badge>}
                            <Badge tone={i.outcome === "RENEWED" ? "green" : i.outcome === "LOST" ? "red" : "default"}>{i.outcome === "RENEWED" ? "Renewed" : i.outcome === "LOST" ? "Lost" : "Open"}</Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">Renewal rates used</h2>
                  <p className="text-xs text-subtle">Of subscriptions that ran out between a year and a month ago, the share that was renewed. A brand with too little history uses the overall rate.</p>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2 text-sm">
                  <Badge tone={rates.overall.source === "learned" ? "green" : "default"}>
                    Overall {rates.overall.rate}% {rates.overall.source === "learned" ? `(of ${rates.overall.sample})` : "(standard)"}
                  </Badge>
                  {Object.entries(rates.byBrand)
                    .filter(([, r]) => r.source === "learned")
                    .map(([brand, r]) => (
                      <Badge key={brand} tone="blue">
                        {brand} {r.rate}% (of {r.sample})
                      </Badge>
                    ))}
                </CardContent>
              </Card>
            </>
          );
        })()}

        {view === "collections" && (() => {
          const b = data.collections.buckets;
          const pick = selected ?? data.periods[0]!.key;
          const bills = data.collections.bills.filter((bill) => bill.bucket === pick).sort((a, z) => z.balance - a.balance);
          return (
            <>
              <Card>
                <CardContent className="py-4">
                  <ForecastChart
                    title="Collections forecast"
                    labels={labels}
                    series={[
                      { key: "due", label: "Due, as invoiced", color: COLORS.due, values: data.periods.map((p) => b.periods[p.key]!.dueAsWritten) },
                      { key: "expected", label: "Expected, given how they pay", color: COLORS.forecast, values: data.periods.map((p) => b.periods[p.key]!.expected) },
                    ]}
                  />
                </CardContent>
              </Card>
              <Card className="overflow-x-auto">
                <table className="w-full min-w-[40rem] text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">Period</th>
                      <th className="px-3 py-2 text-right font-medium">Due, as invoiced</th>
                      <th className="px-3 py-2 text-right font-medium">Expected in</th>
                      <th className="px-3 py-2 text-right font-medium">Bills expected</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.periods.map((p) => {
                      const cell = b.periods[p.key]!;
                      return (
                        <tr key={p.key} className={cn("border-b border-line", pick === p.key && "bg-brand-subtle/40")}>
                          <td className="px-3 py-2">
                            <Link href={link(p.key)} className="font-medium text-text hover:underline">
                              {p.label}
                            </Link>
                          </td>
                          <Num v={cell.dueAsWritten} />
                          <td className="px-3 py-2 text-right font-semibold tabular-nums text-text">{inr(cell.expected)}</td>
                          <Num v={cell.bills} plain />
                        </tr>
                      );
                    })}
                    <tr className={cn("border-b border-line", pick === "OVERDUE" && "bg-brand-subtle/40")}>
                      <td className="px-3 py-2">
                        <Link href={link("OVERDUE")} className="font-medium text-danger hover:underline">
                          Already overdue
                        </Link>
                        <div className="text-[11px] text-subtle">When it arrives is the one thing nobody knows</div>
                      </td>
                      <Num v={b.overdue.dueAsWritten} />
                      <td className="px-3 py-2 text-right tabular-nums text-muted">—</td>
                      <Num v={b.overdue.bills} plain />
                    </tr>
                    <tr>
                      <td className="px-3 py-2 text-muted">Later</td>
                      <Num v={b.after.dueAsWritten} />
                      <Num v={b.after.expected} />
                      <Num v={b.after.bills} plain />
                    </tr>
                  </tbody>
                </table>
              </Card>
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">{pick === "OVERDUE" ? "Overdue bills" : titleFor(pick, data.periods, "Expected in")}</h2>
                </CardHeader>
                <CardContent className="p-0">
                  {bills.length === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-subtle">Nothing here.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {bills.map((bill) => (
                        <li key={bill.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                          <div className="min-w-0">
                            <Link href={`/companies/${bill.company.id}?tab=payments`} className="font-medium text-text hover:underline">
                              {bill.company.name}
                            </Link>
                            <div className="text-xs text-muted">
                              {bill.ref} · due {d(bill.dueOn)}
                              {bill.averageDaysLate !== null && bill.averageDaysLate > 0 && ` · usually ${Math.round(bill.averageDaysLate)} days late, so ~${d(bill.expected)}`}
                            </div>
                          </div>
                          <span className="tabular-nums text-text">{inr(bill.balance)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          );
        })()}

        {view === "amc" && (() => {
          const b = data.amc.buckets;
          const pick = selected ?? data.periods[0]!.key;
          const assets = data.amc.assets.filter((a) => a.bucket === pick);
          const byCompany = new Map<string, { name: string; machines: typeof assets }>();
          for (const a of assets) {
            if (!byCompany.has(a.company.id)) byCompany.set(a.company.id, { name: a.company.name, machines: [] });
            byCompany.get(a.company.id)!.machines.push(a);
          }
          return (
            <>
              <Card className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                      <th className="px-3 py-2 font-medium">Warranty ends in</th>
                      <th className="px-3 py-2 text-right font-medium">Machines with no AMC to follow</th>
                      <th className="px-3 py-2 text-right font-medium">Customers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.periods.map((p) => ({ key: p.key, label: p.label, cell: b.periods[p.key]! })), { key: BEFORE, label: "Already ended, in the last 90 days", cell: b.before }].map((r) => (
                      <tr key={r.key} className={cn("border-b border-line last:border-0", pick === r.key && "bg-brand-subtle/40")}>
                        <td className="px-3 py-2">
                          <Link href={link(r.key)} className="font-medium text-text hover:underline">
                            {r.label}
                          </Link>
                        </td>
                        <Num v={r.cell.machines} plain />
                        <Num v={r.cell.customers} plain />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Card>
                <CardHeader>
                  <h2 className="text-sm font-semibold text-text">{titleFor(pick, data.periods, "Out of warranty")}</h2>
                  <p className="text-xs text-subtle">Customers&apos; own machines, by customer — an AMC is sold to the customer, not the machine.</p>
                </CardHeader>
                <CardContent className="p-0">
                  {byCompany.size === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-subtle">Nothing comes out of warranty here without cover to follow.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {[...byCompany.entries()]
                        .sort((a, z) => z[1].machines.length - a[1].machines.length)
                        .map(([id, c]) => (
                          <li key={id} className="px-5 py-2.5 text-sm">
                            <div className="flex items-center justify-between gap-2">
                              <Link href={`/companies/${id}?tab=assets`} className="font-medium text-text hover:underline">
                                {c.name}
                              </Link>
                              <span className="text-xs text-muted">
                                {c.machines.length} machine{c.machines.length === 1 ? "" : "s"}
                              </span>
                            </div>
                            <div className="text-xs text-muted">
                              {c.machines
                                .slice(0, 6)
                                .map((m) => `${m.name}${m.serial ? ` (${m.serial})` : ""} — ${d(m.warrantyEndsOn)}`)
                                .join(" · ")}
                              {c.machines.length > 6 && ` · and ${c.machines.length - 6} more`}
                            </div>
                          </li>
                        ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </>
          );
        })()}

        {view === "commits" && <CommitsView />}
      </div>
    </div>
  );
}

async function CommitsView() {
  const commits = await getCommits();
  if (!commits) return null;
  return <CommitsPanel labels={Object.fromEntries(commits.months.map((m) => [m.key, m.label]))} mine={commits.mine} team={commits.team} />;
}

function titleFor(key: string, periods: { key: string; label: string }[], prefix = "Deals closing"): string {
  if (key === BEFORE) return prefix === "Deals closing" ? "Slipped deals — the close date has passed" : `${prefix} — before this period`;
  if (key === AFTER) return `${prefix} — later`;
  if (key === UNDATED) return "Deals with no close date";
  const period = periods.find((p) => p.key === key);
  return `${prefix} — ${period?.label ?? key}`;
}

function Num({ v, plain = false }: { v: number | null; plain?: boolean }) {
  return <td className="px-3 py-2 text-right tabular-nums text-muted">{v === null ? "—" : plain ? v : v === 0 ? "—" : formatCurrency(v)}</td>;
}

function OutsideRow({ label, hint, cell, active, href }: { label: string; hint?: string; cell: { deals: number; pipeline: number; bestCase: number; commit: number; weighted: number }; active: boolean; href: LinkProps["href"] }) {
  return (
    <tr className={cn("border-b border-line last:border-0", active && "bg-brand-subtle/40")}>
      <td className="px-3 py-2">
        <Link href={href} className="font-medium text-muted hover:underline">
          {label}
        </Link>
        {hint && <div className="text-[11px] text-subtle">{hint}</div>}
      </td>
      <Num v={cell.deals} plain />
      <Num v={cell.pipeline} />
      <Num v={cell.bestCase} />
      <Num v={cell.commit} />
      <td className="px-3 py-2 text-right tabular-nums text-muted">{cell.weighted ? formatCurrency(cell.weighted) : "—"}</td>
      <td colSpan={4} />
    </tr>
  );
}

function DealList({
  deals,
  title,
  clock,
}: {
  deals: { id: string; ref: number; title: string; stage: string; value: number | null; valueSource: string | null; closeDate: Date | string | null; weighted: number | null; owner: { name: string } | null; company: { id: string; name: string } }[];
  title: string;
  clock: Clock;
}) {
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
      </CardHeader>
      <CardContent className="p-0">
        {deals.length === 0 ? (
          <p className="px-5 py-6 text-center text-sm text-subtle">No open deals here.</p>
        ) : (
          <ul className="divide-y divide-line">
            {deals.slice(0, 50).map((deal) => (
              <li key={deal.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <div className="min-w-0">
                  <Link href={`/leads/${deal.id}`} className="font-medium text-text hover:underline">
                    {deal.title}
                  </Link>
                  <div className="text-xs text-muted">
                    {deal.company.name} · {STAGE_LABEL[deal.stage as keyof typeof STAGE_LABEL] ?? deal.stage} · closes {clock.date(deal.closeDate)}
                    {deal.owner && ` · ${deal.owner.name}`}
                  </div>
                </div>
                <div className="text-right">
                  <div className="tabular-nums text-text">{deal.weighted === null ? "no value" : formatCurrency(deal.weighted)}</div>
                  <div className="text-[11px] text-subtle">
                    {deal.value === null ? "add an estimate or a proposal" : `of ${compactInr(deal.value)} · ${deal.valueSource}`}
                  </div>
                </div>
              </li>
            ))}
            {deals.length > 50 && <li className="px-5 py-2 text-xs text-subtle">And {deals.length - 50} more, smaller.</li>}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
