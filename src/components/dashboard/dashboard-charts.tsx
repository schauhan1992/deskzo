"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, Eye, KeyRound, Laptop, Minus, ShieldAlert, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { shortRupees, weekly, type ActivityIcon, type ChartData, type ChartType, type RowsData, type SeriesData, type Tone } from "@/lib/dashboard/charts";

/**
 * The dashboard's charts, drawn from the figures src/lib/dashboard/data.ts hands over.
 *
 * Plain elements and inline SVG rather than a chart library: nine small shapes, and every colour a token,
 * so the brand colour from Settings and dark mode reach them as they reach everything else.
 *
 * The default palette is one hue — the brand — in steps, then greys: a chart is read by position and
 * label here, and a rainbow on every card would make the dashboard louder than the work on it.
 */

const MIX = (pct: number, into: string) => `color-mix(in srgb, var(--brand) ${pct}%, ${into})`;
/** Series, by position: the brand, a light tint of it, then two greys. */
const SERIES = ["var(--brand)", MIX(38, "var(--surface)"), "var(--text-subtle)", "var(--line-strong)"];
/** Slices, by position: the brand from deep to pale, then greys. */
const RAMP = [MIX(70, "var(--text)"), "var(--brand)", MIX(60, "var(--surface)"), MIX(35, "var(--surface)"), "var(--text-subtle)", "var(--line-strong)"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const CHART_HEIGHT = 212;

type Plot = { labels: string[]; series: { name: string; values: number[] }[]; stacked: boolean; unit?: string; yMax?: number; money?: boolean };

/** A series as it is drawn for a type: by the week once a range is too long to show day by day. */
function plotOf(data: SeriesData, type: ChartType): Plot {
  const days = data.grain === "day" ? data.keys.length : Infinity;
  const byDay = data.grain === "day" && (days <= 7 || ((type === "line" || type === "area") && days <= 31));
  const shown = data.grain === "month" || byDay ? data : weekly(data);
  const label = (key: string) => {
    if (shown.grain === "month") return MONTHS[Number(key.slice(5, 7)) - 1]!;
    if (days <= 7) return WEEKDAYS[new Date(`${key}T00:00:00Z`).getUTCDay()]!;
    return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
  };
  return { labels: shown.keys.map(label), series: shown.series, stacked: shown.stacked && type === "bar", money: data.money };
}

export function ChartView({
  type,
  data,
  height = CHART_HEIGHT,
  onToggleTask,
}: {
  type: ChartType;
  data: ChartData;
  height?: number;
  /** Ticks a task off from the upcoming list. Left out in the builder's preview, where nothing is real yet. */
  onToggleTask?: (id: string) => void;
}) {
  switch (data.kind) {
    case "number":
      return <NumberView value={data.value} delta={data.delta} tone={data.tone} exact={data.exact} height={height} />;
    case "rows":
      return <RowsTable data={data} height={height} />;
    case "tasks":
      return <TaskList items={data.items} height={height} onToggle={onToggleTask} />;
    case "activity":
      return <ActivityList items={data.items} ownOnly={data.ownOnly} height={height} />;
    case "leads":
      return <LeadsTable rows={data.rows} height={height} />;
    case "team":
      if (type === "table") return <TeamTable rows={data.rows} height={height} />;
      if (type === "hbar") return <HBars items={data.rows.map((r) => ({ label: r.name.split(" ")[0]!, value: r.onTime }))} unit="%" max={100} height={height} />;
      return (
        <SeriesChart
          mode="bar"
          plot={{ labels: data.rows.map((r) => r.name.split(" ")[0]!), series: [{ name: "On-time rate", values: data.rows.map((r) => r.onTime) }], stacked: false, unit: "%", yMax: 100 }}
          height={height}
          empty="No tasks finished in this period."
        />
      );
    case "series":
      return <SeriesChart mode={type === "line" || type === "area" ? type : "bar"} plot={plotOf(data, type)} height={height} empty="Nothing in this period yet." />;
    case "category":
      // A figure that is also a split of itself (receivables: current and overdue) draws as either.
      if (type === "number" && data.headline) return <NumberView {...data.headline} height={height} />;
      if (type === "hbar") return <HBars items={data.items} money={data.money} height={height} />;
      if (type === "donut" || type === "pie") return <Donut items={data.items} pie={type === "pie"} money={data.money} height={height} />;
      return (
        <SeriesChart
          mode={type === "line" || type === "area" ? type : "bar"}
          plot={{ labels: data.items.map((i) => i.label), series: [{ name: data.money ? "Amount" : "Count", values: data.items.map((i) => i.value) }], stacked: false, money: data.money }}
          height={height}
          empty="Nothing to show yet."
        />
      );
  }
}

function EmptyChart({ height, children }: { height: number; children: ReactNode }) {
  return (
    <div className="grid place-items-center text-center text-sm text-subtle" style={{ height }}>
      {children}
    </div>
  );
}

// ─── Columns, lines and areas ────────────────────────────────────────────────

function niceMax(v: number) {
  if (v <= 0) return 10;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const fmt = (v: number) => (v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(Math.round(v * 10) / 10));

function SeriesChart({ mode, plot, height, empty }: { mode: "bar" | "line" | "area"; plot: Plot; height: number; empty: string }) {
  const [hover, setHover] = useState<number | null>(null);
  // As many dates along the bottom as fit — about one per 72px — rather than a fixed count that collides on a narrow card.
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(6);
  const blank = plot.labels.length === 0 || plot.series.every((s) => s.values.every((v) => v === 0));
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setRoom(Math.max(2, Math.floor((e!.contentRect.width - 32) / 72))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [blank]);
  const { labels, series, stacked, unit = "", money = false } = plot;
  const n = labels.length;
  if (blank) return <EmptyChart height={height}>{empty}</EmptyChart>;

  // Rupees are drawn short on the axis (₹2.6 Cr) and in full enough to read in the tooltip.
  const axis = (v: number) => (money ? shortRupees(v, 1) : fmt(v));
  const tip = (v: number) => (money ? shortRupees(v) : `${v}${unit}`);
  const L = money ? 52 : 32, T = 6, B = 22;
  const peak = stacked ? Math.max(...labels.map((_, i) => series.reduce((a, s) => a + s.values[i]!, 0))) : Math.max(...series.flatMap((s) => s.values));
  // A line can go below nothing — a cash balance overdrawn — so its scale does too; columns start at zero.
  const trough = mode === "bar" ? 0 : Math.min(0, ...series.flatMap((s) => s.values));
  const min = trough < 0 ? -niceMax(-trough * 1.05) : 0;
  const max = plot.yMax ?? (peak > 0 ? niceMax(peak * 1.05) : min < 0 ? 0 : 10);
  const pct = (v: number) => Math.max(0, ((v - min) / (max - min)) * 100);
  const xAt = mode === "bar" ? (i: number) => ((i + 0.5) / n) * 100 : (i: number) => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const plotBox = { left: L, right: 0, top: T, bottom: B };
  const step = Math.max(1, Math.ceil(n / room));

  return (
    <div className="flex flex-col gap-3" style={{ height }}>
      <div ref={box} className="relative min-h-0 flex-1">
        {[0, 1, 2, 3, 4].map((t) => {
          const v = min + ((max - min) * t) / 4;
          const top = `calc(${T}px + ${(100 - pct(v)) / 100} * (100% - ${T + B}px))`;
          return (
            <div key={t}>
              <div className={cn("absolute border-t", t === 0 ? "border-line" : "border-line/60")} style={{ left: L, right: 0, top }} />
              <div className="absolute -translate-y-1/2 text-right text-[11px] tabular-nums text-subtle" style={{ left: 0, width: L - 8, top }}>
                {axis(v)}
              </div>
            </div>
          );
        })}

        {mode === "bar" ? (
          <div className="absolute flex" style={plotBox}>
            {labels.map((_, i) => (
              <div key={i} className="flex h-full flex-1 items-end justify-center transition-opacity" style={{ opacity: hover !== null && hover !== i ? 0.5 : 1 }}>
                {stacked ? (
                  <div className="flex h-full w-[56%] max-w-[34px] flex-col-reverse">
                    {series.map((s, si) => (
                      <div
                        key={si}
                        className="flex-none"
                        style={{ height: `${(s.values[i]! / max) * 100}%`, background: SERIES[si % SERIES.length], borderRadius: si === series.length - 1 ? "4px 4px 0 0" : 0 }}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="flex h-full w-[56%] max-w-[40px] items-end justify-center gap-[3px]">
                    {series.map((s, si) => (
                      <div key={si} className="flex-1 rounded-t" style={{ height: `${pct(s.values[i]!)}%`, background: SERIES[si % SERIES.length] }} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <>
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute overflow-visible"
              style={{ left: L, top: T, width: `calc(100% - ${L}px)`, height: `calc(100% - ${T + B}px)` }}
              aria-hidden="true"
            >
              {series.map((s, si) => {
                const pts = s.values.map((v, i) => [xAt(i), 100 - pct(v)] as const);
                const d = "M" + pts.map((p) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join(" L");
                const colour = SERIES[si % SERIES.length];
                return (
                  <g key={si}>
                    {mode === "area" && <path d={`${d} L${pts[n - 1]![0]} 100 L${pts[0]![0]} 100 Z`} fill={colour} fillOpacity={si === 0 ? 0.1 : 0.06} stroke="none" />}
                    <path d={d} fill="none" stroke={colour} strokeWidth={si === 0 ? 2 : 1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
            </svg>
            {hover !== null && (
              <div className="pointer-events-none absolute" style={plotBox}>
                <div className="absolute inset-y-0 border-l border-dashed border-line-strong" style={{ left: `${xAt(hover)}%` }} />
                {series.map((s, si) => (
                  <div
                    key={si}
                    className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-surface"
                    style={{ left: `${xAt(hover)}%`, top: `${100 - pct(s.values[hover]!)}%`, borderColor: SERIES[si % SERIES.length] }}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {labels.map((label, i) => {
          if ((n - 1 - i) % step !== 0) return null;
          const x = xAt(i);
          const shift = mode !== "bar" && x < 4 ? "none" : mode !== "bar" && x > 96 ? "translateX(-100%)" : "translateX(-50%)";
          return (
            <div key={i} className="absolute bottom-0 whitespace-nowrap text-[11px] text-subtle" style={{ left: `calc(${L}px + ${x / 100} * (100% - ${L}px))`, transform: shift }}>
              {label}
            </div>
          );
        })}

        <div className="absolute flex" style={plotBox} onMouseLeave={() => setHover(null)}>
          {labels.map((_, i) => (
            <div key={i} className="h-full flex-1" onMouseEnter={() => setHover(i)} />
          ))}
        </div>

        {hover !== null && (
          <div
            className="pointer-events-none absolute z-[3] whitespace-nowrap rounded-lg border border-line bg-surface-raised px-2.5 py-[7px] text-xs shadow-md"
            style={{
              top: T,
              left: `calc(${L}px + ${xAt(hover) / 100} * (100% - ${L}px))`,
              transform: hover >= n / 2 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
            }}
          >
            <div className="mb-1 font-medium text-text">{labels[hover]}</div>
            {series.map((s, si) => (
              <div key={s.name} className="flex items-center gap-1.5 text-muted">
                <span className="h-[7px] w-[7px] rounded-full" style={{ background: SERIES[si % SERIES.length] }} />
                {s.name}
                <span className="ml-auto pl-3 font-medium tabular-nums text-text">{tip(s.values[hover]!)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {series.length > 1 && <Legend items={series.map((s, i) => ({ name: s.name, colour: SERIES[i % SERIES.length]! }))} />}
    </div>
  );
}

function Legend({ items }: { items: { name: string; colour: string }[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
      {items.map((s) => (
        <span key={s.name} className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full" style={{ background: s.colour }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

// ─── Bars, donuts, pies ──────────────────────────────────────────────────────

function HBars({ items, unit = "", max: fixedMax, money = false, height }: { items: { label: string; value: number }[]; unit?: string; max?: number; money?: boolean; height: number }) {
  const max = fixedMax ?? Math.max(...items.map((x) => x.value), 0);
  if (items.length === 0 || max === 0) return <EmptyChart height={height}>Nothing to show yet.</EmptyChart>;
  return (
    <div
      className="grid content-center items-center gap-x-3.5"
      style={{ height, gridTemplateColumns: `minmax(0,auto) minmax(0,1fr) ${money ? "72px" : "40px"}`, rowGap: items.length > 4 ? 12 : 20 }}
    >
      {items.flatMap((it, i) => [
        <span key={`l${i}`} className="truncate text-right text-[13px] text-muted">
          {it.label}
        </span>,
        <div key={`t${i}`} className="h-3.5 overflow-hidden rounded bg-surface-sunken">
          <div className="h-full rounded bg-brand" style={{ width: `${(it.value / max) * 100}%` }} />
        </div>,
        <span key={`v${i}`} className="whitespace-nowrap text-right text-[13px] font-medium tabular-nums text-text">
          {money ? shortRupees(it.value) : `${it.value}${unit}`}
        </span>,
      ])}
    </div>
  );
}

function Donut({ items, pie, money = false, height }: { items: { label: string; value: number }[]; pie: boolean; money?: boolean; height: number }) {
  const show = (v: number) => (money ? shortRupees(v) : String(v));
  const total = items.reduce((a, b) => a + b.value, 0);
  if (total === 0) return <EmptyChart height={height}>Nothing to show yet.</EmptyChart>;
  const S = 148, c = S / 2, R = pie ? 37 : 56, SW = pie ? 74 : 20, CIRC = 2 * Math.PI * R;
  // Where each slice starts round the ring: the lengths of those before it.
  const lengths = items.map((it) => (it.value / total) * CIRC);
  const starts = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div className="flex items-center justify-center gap-7" style={{ height }}>
      <div className="relative flex-none" style={{ width: S, height: S }}>
        <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} className="-rotate-90" aria-hidden="true">
          {items.map((_, i) => {
            const gap = items.length > 1 ? (pie ? 0.6 : 1.6) : 0;
            return (
              <circle key={i} cx={c} cy={c} r={R} fill="none" stroke={RAMP[i % RAMP.length]} strokeWidth={SW} strokeDasharray={`${Math.max(0.1, lengths[i]! - gap)} ${CIRC}`} strokeDashoffset={-starts[i]!} />
            );
          })}
        </svg>
        {!pie && (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn("font-semibold leading-[1.1] tracking-tight text-text", money ? "text-base" : "text-2xl")}>{show(total)}</span>
            <span className="text-[11.5px] text-muted">Total</span>
          </div>
        )}
      </div>
      <div className="grid min-w-0 items-center gap-x-2.5 gap-y-[11px]" style={{ gridTemplateColumns: "8px minmax(0,auto) auto" }}>
        {items.flatMap((it, i) => [
          <span key={`d${i}`} className="h-2 w-2 rounded-full" style={{ background: RAMP[i % RAMP.length] }} />,
          <span key={`l${i}`} className="truncate text-[13px] text-text/80">
            {it.label}
          </span>,
          <span key={`v${i}`} className="whitespace-nowrap pl-2.5 text-right text-[13px] font-medium tabular-nums text-text">
            {show(it.value)}
            <span className="font-normal text-subtle"> ({Math.round((it.value / total) * 100)}%)</span>
          </span>,
        ])}
      </div>
    </div>
  );
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

export const TONE_CLASS: Record<Tone, string> = { up: "text-success", down: "text-danger", warn: "text-warning", flat: "text-muted" };
export function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = tone === "down" ? ArrowDown : tone === "flat" ? Minus : ArrowUp;
  return <Icon className={className} aria-hidden="true" />;
}

function NumberView({ value, delta, tone, exact, height }: { value: string; delta: string | null; tone: Tone; exact?: string; height: number }) {
  return (
    <div className="flex flex-col justify-center gap-2" style={{ height }}>
      <span className="text-[44px] font-semibold leading-none tracking-tight text-text" title={exact}>
        {value}
      </span>
      {delta && (
        <span className={cn("inline-flex items-center gap-1 text-[13px] font-medium", TONE_CLASS[tone])}>
          <ToneIcon tone={tone} className="h-[13px] w-[13px]" />
          {delta}
        </span>
      )}
    </div>
  );
}

// ─── Lists and tables ────────────────────────────────────────────────────────

const PILL: Record<string, string> = {
  Urgent: "bg-danger-bg text-danger",
  High: "bg-danger-bg text-danger",
  Medium: "bg-warning-bg text-warning",
  Low: "bg-brand-subtle text-brand",
  New: "bg-brand-subtle text-brand",
  Qualified: "bg-success-bg text-success",
  Proposal: "bg-warning-bg text-warning",
  Negotiation: "bg-warning-bg text-warning",
  Won: "bg-success-bg text-success",
  Lost: "bg-danger-bg text-danger",
  "On track": "bg-success-bg text-success",
  "At risk": "bg-warning-bg text-warning",
  "Off track": "bg-danger-bg text-danger",
};
function Pill({ children }: { children: string }) {
  return <span className={cn("justify-self-start whitespace-nowrap rounded-[5px] px-[7px] py-px text-[11.5px] font-medium", PILL[children] ?? "bg-surface-sunken text-muted")}>{children}</span>;
}

function TaskList({ items, height, onToggle }: { items: { id: string; title: string; priority: string | null; due: string | null; dueSoon: boolean; done: boolean }[]; height: number; onToggle?: (id: string) => void }) {
  if (items.length === 0) return <EmptyChart height={height}>No open tasks with a due date.</EmptyChart>;
  return (
    <div className="flex flex-col overflow-hidden" style={{ height }}>
      {items.map((t, i) => (
        <div key={t.id} className={cn("grid items-center gap-x-3 py-2", i > 0 && "border-t border-line/60")} style={{ gridTemplateColumns: "18px minmax(0,1fr) auto 64px" }}>
          <button
            type="button"
            onClick={() => onToggle?.(t.id)}
            disabled={!onToggle}
            aria-label={t.done ? `Mark "${t.title}" as open` : `Mark "${t.title}" as done`}
            className={cn("grid h-[18px] w-[18px] place-items-center rounded-[5px] border text-brand-contrast", t.done ? "border-brand bg-brand" : "border-line-strong bg-surface")}
          >
            {t.done && <Check className="h-3 w-3" />}
          </button>
          <Link href="/tasks" className={cn("truncate text-[13px] hover:underline", t.done ? "text-subtle line-through" : "text-text")}>
            {t.title}
          </Link>
          {t.priority ? <Pill>{t.priority}</Pill> : <span />}
          <span className={cn("whitespace-nowrap text-right text-[12.5px]", t.dueSoon ? "text-text" : "text-muted")}>{t.due}</span>
        </div>
      ))}
    </div>
  );
}

const ACTIVITY_ICONS: Record<ActivityIcon, typeof Eye> = { "sign-in": KeyRound, read: Eye, security: ShieldAlert, device: Laptop, other: Sparkles };

function ActivityList({ items, ownOnly, height }: { items: { id: string; icon: ActivityIcon; title: string; sub: string; time: string }[]; ownOnly: boolean; height: number }) {
  if (items.length === 0) return <EmptyChart height={height}>Nothing recorded yet.</EmptyChart>;
  return (
    <div className="flex flex-col gap-[11px] overflow-hidden" style={{ height }}>
      {items.slice(0, ownOnly ? 4 : 5).map((a) => {
        const Icon = ACTIVITY_ICONS[a.icon];
        return (
          <div key={a.id} className="flex items-start gap-3">
            <span className="grid h-[30px] w-[30px] flex-none place-items-center rounded-lg bg-surface-sunken text-muted">
              <Icon className="h-[15px] w-[15px]" />
            </span>
            <div className="min-w-0 flex-1 leading-[1.3]">
              <div className="truncate text-[13px] font-medium text-text">{a.title}</div>
              <div className="truncate text-xs text-muted">{a.sub}</div>
            </div>
            <span className="whitespace-nowrap text-xs text-subtle">{a.time}</span>
          </div>
        );
      })}
      {/* Said on the card, because five of your own actions look like five of everybody's. */}
      {ownOnly && <p className="mt-auto text-xs text-subtle">Your own activity.</p>}
    </div>
  );
}

const TH = "border-b border-line/60 pb-1.5 text-[11px] font-medium uppercase tracking-[0.04em] text-subtle whitespace-nowrap";

function LeadsTable({ rows, height }: { rows: { id: string; href: string; name: string; company: string; status: string; owner: string; date: string }[]; height: number }) {
  if (rows.length === 0) return <EmptyChart height={height}>No leads yet.</EmptyChart>;
  const td = "min-w-0 truncate whitespace-nowrap py-[7px] text-[13px]";
  return (
    <div className="grid content-start items-center gap-x-3 overflow-hidden" style={{ height, gridTemplateColumns: "minmax(0,1.2fr) minmax(0,1.2fr) auto minmax(0,0.7fr) auto" }}>
      {["Name", "Company", "Status", "Owner", "Date"].map((t) => (
        <span key={t} className={cn(TH, t === "Date" && "text-right")}>
          {t}
        </span>
      ))}
      {rows.flatMap((x) => [
        <Link key={`a${x.id}`} href={x.href} className={cn(td, "text-text hover:underline")}>
          {x.name}
        </Link>,
        <span key={`b${x.id}`} className={cn(td, "text-muted")}>
          {x.company}
        </span>,
        <span key={`c${x.id}`}>
          <Pill>{x.status}</Pill>
        </span>,
        <span key={`d${x.id}`} className={cn(td, "text-muted")}>
          {x.owner}
        </span>,
        <span key={`e${x.id}`} className={cn(td, "text-right text-muted")}>
          {x.date}
        </span>,
      ])}
    </div>
  );
}

function TeamTable({ rows, height }: { rows: { name: string; initials: string; done: number; onTime: number }[]; height: number }) {
  if (rows.length === 0) return <EmptyChart height={height}>No tasks finished in this period.</EmptyChart>;
  return (
    <div className="grid content-start items-center gap-x-3.5 overflow-hidden" style={{ height, gridTemplateColumns: "minmax(0,1fr) 64px minmax(90px,140px)" }}>
      <span className={TH}>Member</span>
      <span className={cn(TH, "text-right")}>Done</span>
      <span className={TH}>On time</span>
      {rows.slice(0, 5).flatMap((x, i) => [
        <span key={`n${i}`} className="flex min-w-0 items-center gap-2 py-1.5">
          <span className="grid h-6 w-6 flex-none place-items-center rounded-full bg-brand-subtle text-[10px] font-semibold text-brand">{x.initials}</span>
          <span className="truncate text-[13px] text-text">{x.name}</span>
        </span>,
        <span key={`d${i}`} className="text-right text-[13px] tabular-nums text-text">
          {x.done}
        </span>,
        <span key={`o${i}`} className="flex items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-surface-sunken">
            <span className="block h-full bg-brand" style={{ width: `${x.onTime}%` }} />
          </span>
          <span className="w-8 text-right text-[12.5px] tabular-nums text-muted">{x.onTime}%</span>
        </span>,
      ])}
    </div>
  );
}

/** A short table of records — renewals coming up, projects — each row opening its own. */
function RowsTable({ data, height }: { data: RowsData; height: number }) {
  if (data.rows.length === 0) return <EmptyChart height={height}>{data.empty}</EmptyChart>;
  const td = "min-w-0 truncate whitespace-nowrap py-[7px] text-[13px]";
  const template = data.columns.map((c, i) => (i === 0 ? "minmax(0,1.4fr)" : c.align === "right" ? "auto" : "minmax(0,1fr)")).join(" ");
  return (
    <div className="grid content-start items-center gap-x-3 overflow-hidden" style={{ height, gridTemplateColumns: template }}>
      {data.columns.map((c) => (
        <span key={c.label} className={cn(TH, c.align === "right" && "text-right")}>
          {c.label}
        </span>
      ))}
      {data.rows.flatMap((row) =>
        row.cells.map((cell, i) => {
          const key = `${row.id}-${i}`;
          if (i === data.pill) return <span key={key}><Pill>{cell}</Pill></span>;
          const align = data.columns[i]?.align === "right" && "text-right";
          if (i === 0 && row.href) {
            return (
              <Link key={key} href={row.href} className={cn(td, "text-text hover:underline", align)}>
                {cell}
              </Link>
            );
          }
          return (
            <span key={key} className={cn(td, i === 0 ? "text-text" : "text-muted", align)}>
              {cell}
            </span>
          );
        }),
      )}
    </div>
  );
}

// ─── Sparklines ──────────────────────────────────────────────────────────────

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const n = values.length, mx = Math.max(...values), mn = Math.min(...values);
  const pts = values.map((v, i) => [(i / (n - 1)) * 100, 36 - ((v - mn) / (mx - mn || 1)) * 30] as const);
  const d = "M" + pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L");
  return (
    <svg width={76} height={36} viewBox="0 0 100 40" preserveAspectRatio="none" className="block overflow-visible text-brand" aria-hidden="true">
      <path d={`${d} L100 40 L0 40 Z`} fill="currentColor" fillOpacity={0.08} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
