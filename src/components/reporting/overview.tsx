"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileBarChart2, Search, Star } from "lucide-react";
import { listReports, reportingHome, type ReportRow, type ReportingHome } from "@/actions/reporting";
import { cn } from "@/lib/utils";
import { blankChart, blankDefinition, type DateRange, type ReportChart } from "@/lib/reporting/definition";
import { ReportChartBody } from "./report-chart";
import { DateRangeMenu, When } from "./controls";
import { TemplateThumb } from "./templates";
import { useReportRun } from "./use-report-run";

/**
 * Reporting & Analytics — the overview (the approved design's 1a). Four headline figures from whichever sources
 * this person can open, run as them; their favourite reports drawn small; what they opened lately; the reports
 * they can see; who changed which report; and a way in through the templates. Nothing here is a sample: a figure
 * whose source they can't open is not shown at all.
 */
export function ReportingOverview({ home: initial, today }: { home: ReportingHome; today: string }) {
  const [home, setHome] = useState(initial);
  const [loadingKpis, setLoadingKpis] = useState(false);
  const [kpiError, setKpiError] = useState<string | null>(null);

  async function changeRange(range: DateRange) {
    setLoadingKpis(true);
    setKpiError(null);
    try {
      const res = await reportingHome({ range });
      if (res.ok) setHome(res.data);
      else setKpiError(res.error);
    } catch {
      setKpiError("Couldn't load the figures. Try again.");
    } finally {
      setLoadingKpis(false);
    }
  }

  const templates = home.templates.filter((t) => t.available).slice(0, 4);
  const empty = home.migrated && home.total === 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[12.5px] text-muted">Insights</p>
          <h1 className="text-[22px] font-semibold text-text">Reporting &amp; Analytics</h1>
          <p className="text-[13.5px] text-muted">Turn business data into answers — every figure from your own records, as your role allows.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateRangeMenu value={home.range} today={today} onChange={changeRange} disabled={loadingKpis} />
          <Link href="/reports/templates" className="inline-flex h-9 items-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken">
            Explore templates
          </Link>
          <Link href="/reports/new" className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
            Create report
          </Link>
        </div>
      </div>

      {!home.migrated && (
        <p className="rounded-lg border border-warning/40 bg-warning-bg px-4 py-2.5 text-[13px] text-warning">
          Saved reports will work once your workspace has the latest update. The figures below are live.
        </p>
      )}

      {kpiError && <p className="rounded-lg border border-danger/30 bg-danger-bg px-4 py-2.5 text-[13px] text-danger">{kpiError}</p>}
      {home.kpis.length === 0 ? (
        <p className="rounded-xl border border-line bg-surface px-5 py-6 text-[13.5px] text-muted">
          None of the sources Reporting reads are open to your role yet, so there are no headline figures to show.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {home.kpis.map((k) => (
            <div key={k.key} className="flex flex-col rounded-xl border border-line bg-surface p-4 shadow-sm">
              <ReportChartBody chart={{ ...blankChart(`k-${k.key}`, "score", null, null), title: k.label }} run={loadingKpis ? "loading" : k.run} />
              <p className="mt-3 border-t border-line pt-2.5 text-[12px] text-subtle">{k.footer}</p>
            </div>
          ))}
        </div>
      )}

      {empty ? (
        <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
          <span className="mx-auto grid h-11 w-11 place-items-center rounded-full bg-brand-subtle text-brand">
            <FileBarChart2 className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[16px] font-semibold text-text">No reports yet</p>
          <p className="mx-auto mt-1 max-w-md text-[13.5px] text-muted">Build one from scratch over any source you can open, or start from a template and change anything.</p>
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/reports/new" className="inline-flex h-9 items-center rounded-base bg-brand px-3.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110">
              Create report
            </Link>
            <Link href="/reports/templates" className="inline-flex h-9 items-center rounded-base border border-line-strong px-3.5 text-sm font-medium text-text hover:bg-surface-sunken">
              Browse templates
            </Link>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-5">
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-text">Favourites</h2>
                <Link href="/reports/library?tab=favourites" className="text-[13px] font-medium text-brand hover:underline">
                  Manage
                </Link>
              </div>
              {home.favourites.length === 0 ? (
                <p className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center text-[13px] text-muted">
                  Star a report to keep it here — the <Star className="inline h-3.5 w-3.5 align-[-2px]" /> beside its name.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  {home.favourites.map((f) => (
                    <FavouriteCard key={f.id} row={f} chart={f.previewChart} />
                  ))}
                </div>
              )}
            </section>
            <RecentReports initial={home.recent} total={home.total} />
          </div>
          <div className="space-y-5">
            <section className="rounded-xl border border-line bg-surface shadow-sm">
              <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold text-text">Recently viewed</h2>
              {home.recentlyViewed.length === 0 ? (
                <p className="px-4 py-5 text-[13px] text-muted">Reports you open show here.</p>
              ) : (
                <ul>
                  {home.recentlyViewed.map((v) => (
                    <li key={v.id} className="border-b border-line last:border-0">
                      <Link href={`/reports/${v.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-sunken">
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-subtle text-brand">
                          <FileBarChart2 className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-medium text-text">{v.name}</span>
                          <span className="block truncate text-[12px] text-subtle">{v.sourceLabel}</span>
                        </span>
                        <When iso={v.viewedAt} className="shrink-0 text-[12px] text-subtle" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rounded-xl border border-line bg-surface shadow-sm">
              <h2 className="border-b border-line px-4 py-3 text-[15px] font-semibold text-text">Activity</h2>
              {home.activity.length === 0 ? (
                <p className="px-4 py-5 text-[13px] text-muted">Changes to the reports you can see show here.</p>
              ) : (
                <ul>
                  {home.activity.map((a) => (
                    <li key={a.id} className="flex gap-3 border-b border-line px-4 py-2.5 last:border-0">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-sunken text-[10.5px] font-semibold text-muted">{a.initials}</span>
                      <span className="min-w-0">
                        <span className="block text-[13px] text-text">
                          <span className="font-medium">{a.who}</span> {a.what}
                        </span>
                        <When iso={a.at} className="text-[12px] text-subtle" />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {templates.length > 0 && (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-text">Start from a template</h2>
            <Link href="/reports/templates" className="text-[13px] font-medium text-brand hover:underline">
              Browse all {home.templates.length}
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {templates.map((t) => (
              <Link key={t.key} href={`/reports/new?template=${t.key}`} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3 shadow-sm hover:border-brand">
                <span className="grid h-14 w-20 shrink-0 place-items-center rounded-lg bg-surface-sunken text-brand">
                  <TemplateThumb type={t.preview.type} small />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13.5px] font-medium text-text">{t.name}</span>
                  <span className="block text-[12px] text-subtle">
                    {t.sourceLabel} · {t.charts} charts
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** A favourite, drawn small from its own first chart — run as this person, like opening it. */
function FavouriteCard({ row, chart }: { row: ReportRow; chart: ReportChart | null }) {
  const { runs } = useReportRun({ reportId: row.id, definition: blankDefinition(row.source, ""), charts: chart && row.sourceOpen ? [chart] : [], sendDefinition: false });
  return (
    <Link href={`/reports/${row.id}`} className="block overflow-hidden rounded-xl border border-line bg-surface shadow-sm hover:border-brand">
      <div className="h-[132px] border-b border-line bg-surface-sunken/50 px-3 pt-3">
        {chart && row.sourceOpen ? (
          <ReportChartBody chart={{ ...chart, showLegend: false, showValues: false }} run={runs[chart.id]} height={112} compact />
        ) : (
          <div className="grid h-full place-items-center text-[12px] text-subtle">{row.sourceOpen ? "No chart to preview" : "Its source isn't open to you"}</div>
        )}
      </div>
      <div className="px-3.5 py-2.5">
        <p className="truncate text-[13.5px] font-medium text-text">{row.name}</p>
        <p className="text-[12px] text-subtle">
          {row.pages} page{row.pages === 1 ? "" : "s"} · edited <When iso={row.updatedAt} />
        </p>
      </div>
    </Link>
  );
}

function RecentReports({ initial, total }: { initial: ReportRow[]; total: number }) {
  const [tab, setTab] = useState<"all" | "mine" | "shared">("all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState(initial);
  const [state, setState] = useState<"idle" | "loading" | { error: string }>("idle");
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched) return;
    let live = true;
    const t = setTimeout(() => {
      setState("loading");
      listReports({ tab, search, pageSize: 6 })
        .then((res) => {
          if (!live) return;
          if (res.ok) {
            setRows(res.data.rows);
            setState("idle");
          } else setState({ error: res.error });
        })
        .catch(() => live && setState({ error: "Couldn't load the reports." }));
    }, search ? 250 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [tab, search, touched]);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <h2 className="mr-auto text-[15px] font-semibold text-text">Recent reports</h2>
        <label className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
          <input
            value={search}
            onChange={(e) => (setSearch(e.target.value), setTouched(true))}
            placeholder="Search reports…"
            className="h-9 w-52 rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand"
          />
        </label>
        <div className="flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
          {(["all", "mine", "shared"] as const).map((t) => (
            <button key={t} type="button" aria-pressed={tab === t} onClick={() => (setTab(t), setTouched(true))} className={cn("h-7 rounded-md px-3 text-[12.5px] font-medium capitalize", tab === t ? "bg-surface text-text shadow-sm" : "text-muted")}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11.5px] uppercase tracking-[0.05em] text-subtle">
              <th className="px-4 py-2 font-medium">Report</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody className={cn(state === "loading" && "opacity-50")}>
            {typeof state === "object" ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-danger">
                  {state.error}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-muted">
                  {search ? "No reports match." : tab === "shared" ? "Nothing has been shared with you yet." : "No reports here yet."}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                  <td className="px-4 py-2.5">
                    <Link href={`/reports/${r.id}`} className="block">
                      <span className="block font-medium text-text hover:underline">{r.name}</span>
                      {r.description && <span className="block max-w-[340px] truncate text-[12px] text-subtle">{r.description}</span>}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">{r.sourceLabel}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-2 text-text">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-surface-sunken text-[10px] font-semibold text-muted">{r.owner.initials}</span>
                      {r.owner.name}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    <When iso={r.updatedAt} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Link href="/reports/library" className="flex items-center gap-1 border-t border-line px-4 py-2.5 text-[13px] font-medium text-brand hover:underline">
        View all {total} report{total === 1 ? "" : "s"}
        <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </section>
  );
}
