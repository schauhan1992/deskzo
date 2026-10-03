"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronDown, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { cashFlowForPeriod, financeForPeriod } from "@/actions/finance";
import { PERIODS, type PeriodKey } from "@/lib/finance/periods";
import { formatCurrency, cn } from "@/lib/utils";
import { indiaClock } from "@/lib/time/zone";
import type { Basis, CashFlow, IncomeExpense, Outstanding } from "@/lib/finance/dashboard";

/**
 * The finance headlines, as cards.
 *
 * Each card is handed its first set of figures by the page — the two pages that show them read
 * everything in one pass, and a card that fetched for itself would run its queries twice on the
 * page that shows several. After that it owns its own window: changing the period re-reads only
 * that card, because re-rendering a whole accounting page to change one dropdown is a page that
 * flickers every time somebody looks at last quarter.
 *
 * The period is not remembered between visits. That is a deliberate omission rather than an
 * oversight — see the note on `PeriodPicker`.
 *
 * Charts are inline SVG for the same reason the report charts are: no runtime dependency, and
 * `currentColor` plus the app's tokens means dark mode needs no code.
 */

/**
 * The window this card is looking through.
 *
 * Resets to the card's default on every visit, which is what Zoho does and is the right default
 * for a figure somebody checks daily: the fiscal-year total is the question, and a card silently
 * still showing last March because of a click three weeks ago is a number read as current when it
 * is not. Worth revisiting if anybody actually asks for it to stick.
 */
function PeriodPicker({
  value,
  onChange,
  options,
  busy,
}: {
  value: PeriodKey;
  onChange: (next: PeriodKey) => void;
  options: readonly PeriodKey[];
  busy?: boolean;
}) {
  const shown = PERIODS.filter((p) => options.includes(p.key));
  return (
    <span className="relative inline-flex items-center gap-1 text-xs text-muted">
      {busy && <Loader2 className="h-3 w-3 animate-spin" />}
      {/* A bare <select> styled to look like text: the control is a dropdown either way, and
          rebuilding one as a popover would cost keyboard and mobile behaviour that this gets
          from the platform. */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PeriodKey)}
        aria-label="Period"
        className="cursor-pointer appearance-none bg-transparent pr-4 text-right text-xs text-muted outline-none hover:text-text focus-visible:text-text"
      >
        {shown.map((p) => (
          <option key={p.key} value={p.key} className="bg-surface text-text">
            {p.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3" />
    </span>
  );
}

/** Accrual counts what was earned; cash counts what arrived. See the note in finance/dashboard.ts. */
function BasisToggle({ value, onChange }: { value: Basis; onChange: (next: Basis) => void }) {
  return (
    <span className="inline-flex overflow-hidden rounded-base border border-line text-[11px]">
      {(["accrual", "cash"] as const).map((b) => (
        <button
          key={b}
          type="button"
          onClick={() => onChange(b)}
          aria-pressed={value === b}
          className={cn(
            "px-2 py-0.5 capitalize transition-colors",
            value === b ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
          )}
        >
          {b}
        </button>
      ))}
    </span>
  );
}

const SPAN_PERIODS = [
  "thisFiscalYear",
  "lastFiscalYear",
  "thisQuarter",
  "lastQuarter",
  "thisMonth",
  "lastMonth",
  "last12Months",
] as const satisfies readonly PeriodKey[];

// A cash line over a single month is two points and a straight edge, so the short windows are
// left off rather than offered and disappointing.
const FLOW_PERIODS = ["last6Months", "last12Months", "thisFiscalYear", "lastFiscalYear"] as const satisfies readonly PeriodKey[];

const INCOME = "#10b981";
const EXPENSE = "#ef4444";

/** ₹19,96,85,430 is unreadable at a glance; ₹19.97 Cr is the number somebody actually wanted. */
export function compactInr(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)}k`;
  return formatCurrency(n);
}

// ─── Income and expense ─────────────────────────────────────────────────────────────────────────

export function IncomeExpenseCard({
  initial,
  initialPeriod = "thisFiscalYear",
  periodLabel: initialLabel,
}: {
  initial: IncomeExpense;
  initialPeriod?: PeriodKey;
  periodLabel: string;
}) {
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);
  const [basis, setBasis] = useState<Basis>("accrual");
  const [data, setData] = useState(initial);
  const [periodLabel, setPeriodLabel] = useState(initialLabel);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reload(nextPeriod: PeriodKey, nextBasis: Basis) {
    setPeriod(nextPeriod);
    setBasis(nextBasis);
    setError(null);
    startTransition(async () => {
      const r = await financeForPeriod(nextPeriod, nextBasis);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setData(r.data.incomeExpense);
      setPeriodLabel(r.data.periodLabel);
    });
  }

  const peak = Math.max(...data.months.flatMap((m) => [m.income, m.expense]), 1);
  const W = 640;
  const H = 180;
  const step = W / Math.max(1, data.months.length);
  const barW = Math.min(14, step * 0.28);

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Income and expense</h2>
        <PeriodPicker value={period} onChange={(next) => reload(next, basis)} options={SPAN_PERIODS} busy={pending} />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <Figure colour={INCOME} label="Total income" value={data.totalIncome} />
            <Figure colour={EXPENSE} label="Total expenses" value={data.totalExpense} />
          </div>
          <BasisToggle value={basis} onChange={(next) => reload(period, next)} />
        </div>

        {error && <p className="rounded-md bg-danger-bg px-3 py-1.5 text-xs text-danger">{error}</p>}

        {data.months.every((m) => m.income === 0 && m.expense === 0) ? (
          <Empty>Nothing posted to income or expense in this period.</Empty>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={W}
                y1={H - 26 - f * (H - 40)}
                y2={H - 26 - f * (H - 40)}
                className="stroke-current text-line"
              />
            ))}
            {data.months.map((m, i) => {
              const base = H - 26;
              const plot = H - 40;
              const mid = step * i + step / 2;
              return (
                <g key={m.key}>
                  <rect
                    x={mid - barW - 1}
                    y={base - (m.income / peak) * plot}
                    width={barW}
                    height={Math.max(0, (m.income / peak) * plot)}
                    rx={2}
                    fill={INCOME}
                  >
                    <title>{`${m.label} income: ${formatCurrency(m.income)}`}</title>
                  </rect>
                  <rect
                    x={mid + 1}
                    y={base - (m.expense / peak) * plot}
                    width={barW}
                    height={Math.max(0, (m.expense / peak) * plot)}
                    rx={2}
                    fill={EXPENSE}
                  >
                    <title>{`${m.label} expense: ${formatCurrency(m.expense)}`}</title>
                  </rect>
                  <text x={mid} y={H - 10} textAnchor="middle" className="fill-current text-[9px] text-subtle">
                    {m.label}
                  </text>
                </g>
              );
            })}
          </svg>
        )}

        {/* Said because it is a real difference from the invoice totals, and somebody reconciling
            the two will otherwise assume one of them is broken. */}
        <p className="text-xs text-subtle">
          {periodLabel} · posted to the ledger, so exclusive of tax.{" "}
          {data.basis === "cash"
            ? "Cash basis — money in and out, so top expenses stays on accrual."
            : "Accrual basis — everything raised, whether or not it has been paid."}
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Top expenses ───────────────────────────────────────────────────────────────────────────────

export function TopExpensesCard({
  initial,
  initialPeriod = "thisFiscalYear",
  periodLabel: initialLabel,
}: {
  initial: { name: string; amount: number }[];
  initialPeriod?: PeriodKey;
  periodLabel: string;
}) {
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);
  const [rows, setRows] = useState(initial);
  const [periodLabel, setPeriodLabel] = useState(initialLabel);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reload(next: PeriodKey) {
    setPeriod(next);
    setError(null);
    startTransition(async () => {
      // Accrual whatever the other card is set to: money leaving the bank does not say what it
      // was for, so there is no cash-basis breakdown to show. See topExpenses in
      // lib/finance/dashboard.ts.
      const r = await financeForPeriod(next, "accrual");
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setRows(r.data.topExpenses);
      setPeriodLabel(r.data.periodLabel);
    });
  }

  const total = rows.reduce((t, r) => t + r.amount, 0);

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Top expenses</h2>
        <PeriodPicker value={period} onChange={reload} options={SPAN_PERIODS} busy={pending} />
      </CardHeader>
      <CardContent>
        {error && <p className="mb-2 rounded-md bg-danger-bg px-3 py-1.5 text-xs text-danger">{error}</p>}
        {/* The label is not lowercased: they read "FY 2026-27" and "Q2 2026-27", and a blanket
            toLowerCase turns those into "fy" and "q2". */}
        {rows.length === 0 ? (
          <Empty>No expenses recorded for {periodLabel}.</Empty>
        ) : (
          <ul className="space-y-2.5">
            {rows.map((r) => (
              <li key={r.name}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-text">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-muted">{compactInr(r.amount)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${total > 0 ? (r.amount / total) * 100 : 0}%`, backgroundColor: EXPENSE }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Cash flow ──────────────────────────────────────────────────────────────────────────────────

export function CashFlowCard({
  initial,
  initialPeriod = "last12Months",
  from: initialFrom,
  to: initialTo,
}: {
  initial: CashFlow;
  initialPeriod?: PeriodKey;
  from: Date;
  to: Date;
}) {
  const [period, setPeriod] = useState<PeriodKey>(initialPeriod);
  const [data, setData] = useState(initial);
  const [range, setRange] = useState({ from: initialFrom, to: initialTo });
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reload(next: PeriodKey) {
    setPeriod(next);
    setError(null);
    startTransition(async () => {
      const r = await cashFlowForPeriod(next);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setData(r.data.cashFlow);
      // The dates come back from the server rather than being worked out here: the window the
      // figures were computed over and the window the labels claim have to be the same one.
      setRange({ from: new Date(r.data.from), to: new Date(r.data.to) });
    });
  }

  const { from, to } = range;
  const W = 620;
  const H = 190;
  const values = data.points.map((p) => p.balance);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const x = (i: number) => (data.points.length <= 1 ? W / 2 : (i / (data.points.length - 1)) * (W - 8) + 4);
  const y = (v: number) => 12 + (1 - (v - min) / span) * (H - 44);

  const line = data.points.map((p, i) => `${x(i)},${y(p.balance)}`).join(" ");

  return (
    <Card className="h-full">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Cash flow</h2>
        <PeriodPicker value={period} onChange={reload} options={FLOW_PERIODS} busy={pending} />
      </CardHeader>
      {error && <p className="px-5 pb-1 text-xs text-danger">{error}</p>}
      <CardContent className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          {data.points.length === 0 ? (
            <Empty>No cash movement recorded.</Empty>
          ) : (
            <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img">
              {/* The filled area under the line, closed along the bottom. */}
              <polygon points={`4,${H - 28} ${line} ${x(data.points.length - 1)},${H - 28}`} fill="#3b82f6" opacity={0.12} />
              <polyline points={line} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinejoin="round" />
              {data.points.map((p, i) => (
                <circle key={p.key} cx={x(i)} cy={y(p.balance)} r={2.5} fill="#3b82f6">
                  <title>{`${p.label}: ${formatCurrency(p.balance)}`}</title>
                </circle>
              ))}
              {data.points.map((p, i) => (
                <text
                  key={p.key}
                  x={x(i)}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-current text-[9px] text-subtle"
                  opacity={data.points.length <= 12 || i % 2 === 0 ? 1 : 0}
                >
                  {p.label}
                </text>
              ))}
            </svg>
          )}
        </div>

        {/* The window's first and last days are India's (src/lib/finance/periods.ts): the books' calendar. */}
        <dl className="w-full shrink-0 space-y-2 lg:w-56">
          <Movement dot="bg-subtle" label={`Cash as on ${indiaClock.date(from)}`} value={data.opening} />
          <Movement dot="bg-success" label="Incoming" value={data.incoming} sign="+" />
          <Movement dot="bg-danger" label="Outgoing" value={data.outgoing} sign="−" />
          <Movement dot="bg-brand" label={`Cash as on ${indiaClock.date(to)}`} value={data.closing} sign="=" strong />
        </dl>
      </CardContent>
    </Card>
  );
}

// ─── Receivables and payables ───────────────────────────────────────────────────────────────────

export function OutstandingCard({
  title,
  subtitle,
  data,
  href,
  newHref,
  newLabel,
}: {
  title: string;
  subtitle: string;
  data: Outstanding;
  href: string;
  newHref?: string;
  newLabel?: string;
}) {
  const pct = data.total > 0 ? (data.current / data.total) * 100 : 0;

  return (
    <Card className="h-full">
      <CardHeader className="flex items-center justify-between gap-2">
        <Link href={href} className="text-sm font-semibold text-text hover:underline">
          {title}
        </Link>
        {newHref && (
          <Link href={newHref} className="text-xs font-medium text-brand hover:underline">
            + {newLabel}
          </Link>
        )}
      </CardHeader>
      <CardContent className="space-y-2.5">
        <div>
          <p className="text-xs text-muted">{subtitle}</p>
          <p className="mt-0.5 text-xl font-semibold text-text">{formatCurrency(data.total)}</p>
        </div>

        {/* Zero gets a flat neutral bar rather than a full orange one — nothing outstanding should
            not look like everything overdue. */}
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-sunken">
          {data.total > 0 && (
            <>
              <div className="h-full bg-brand" style={{ width: `${pct}%` }} />
              <div className="h-full bg-warning" style={{ width: `${100 - pct}%` }} />
            </>
          )}
        </div>

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Legend dot="bg-brand" label="Current" value={data.current} />
          <Legend dot="bg-warning" label="Overdue" value={data.overdue} tone={data.overdue > 0 ? "text-warning" : undefined} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Small pieces ───────────────────────────────────────────────────────────────────────────────

function Figure({ colour, label, value }: { colour: string; label: string; value: number }) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: colour }} />
        {label}
      </p>
      {/* The full number in the tooltip: a compact figure is for reading, not for reconciling. */}
      <p className="text-lg font-semibold text-text" title={formatCurrency(value)}>
        {compactInr(value)}
      </p>
    </div>
  );
}

function Movement({
  dot,
  label,
  value,
  sign,
  strong,
}: {
  dot: string;
  label: string;
  value: number;
  sign?: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="flex items-center gap-1.5 truncate text-xs text-muted">
        <span className={cn("h-2 w-2 shrink-0 rounded-sm", dot)} />
        {label}
      </dt>
      <dd
        className={cn("shrink-0 tabular-nums", strong ? "text-sm font-semibold text-text" : "text-xs text-text")}
        title={formatCurrency(value)}
      >
        {compactInr(value)} {sign && <span className="text-subtle">({sign})</span>}
      </dd>
    </div>
  );
}

function Legend({ dot, label, value, tone }: { dot: string; label: string; value: number; tone?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-sm", dot)} />
      <span className="text-muted">{label}:</span>
      <span className={cn("tabular-nums", tone ?? "text-text")} title={formatCurrency(value)}>
        {formatCurrency(value)}
      </span>
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-10 text-center text-sm text-subtle">{children}</p>;
}
