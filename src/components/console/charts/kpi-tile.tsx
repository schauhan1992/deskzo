import type { ReactNode } from "react";
import Link from "next/link";
import { Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Meter } from "./meter";
import { Sparkline } from "./sparkline";

type KpiTone = "neutral" | "success" | "info" | "warning" | "danger";

const CHIP: Record<KpiTone, string> = {
  neutral: "bg-surface-sunken text-muted",
  success: "bg-success-bg text-success",
  info: "bg-info-bg text-info",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

// Only warning and danger colour the figure itself: a green or blue number says nothing a plain
// one does not, and colour kept for trouble is colour that gets noticed.
const VALUE: Record<KpiTone, string> = {
  neutral: "text-text",
  success: "text-text",
  info: "text-text",
  warning: "text-warning",
  danger: "text-danger",
};

const TILE = "block rounded-xl border border-line bg-surface p-4 shadow-sm";

/**
 * One headline figure: an icon and a label, the value, a line of context, and optionally a
 * change against a named period, a trend or a meter.
 *
 * With `href` the whole tile is one link to the list behind the number ("Held 3" opens the held
 * workspaces) — one tab stop, named by everything the tile says. Money tiles pass a `MoneyList` as
 * `value`: one line per currency, never a sum.
 *
 * The trend is decorative (the value is already stated in words); `delta.good` says whether this
 * direction is good news, which is what colours it — up is bad for "past due".
 */
export function KpiTile({
  label,
  value,
  icon,
  href,
  secondary,
  tone = "neutral",
  trend,
  delta,
  meter,
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  href?: string;
  secondary?: ReactNode;
  tone?: KpiTone;
  trend?: { values: number[]; label: string };
  delta?: { text: string; direction: "up" | "down" | "flat"; good?: boolean };
  meter?: { value: number; max: number | null; label: string };
}) {
  const body = (
    <>
      <div className="flex items-center gap-2.5">
        {icon && (
          <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", CHIP[tone])} aria-hidden="true">
            {icon}
          </span>
        )}
        <p className="min-w-0 text-xs font-medium text-muted">{label}</p>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div className={cn("min-w-0 text-2xl font-semibold tracking-tight tabular-nums", VALUE[tone])}>{value}</div>
        {trend && trend.values.length > 1 && (
          <div className="mb-1 shrink-0">
            <Sparkline values={trend.values} label={trend.label} decorative />
          </div>
        )}
      </div>
      {meter && (
        <div className="mt-2.5">
          <Meter value={meter.value} max={meter.max} label={meter.label} />
        </div>
      )}
      {(delta || secondary) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          {delta && <DeltaChip {...delta} />}
          {secondary && <span className="min-w-0">{secondary}</span>}
        </div>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={cn(TILE, "transition-colors hover:border-line-strong")}>
        {body}
      </Link>
    );
  }
  return <div className={TILE}>{body}</div>;
}

function DeltaChip({ text, direction, good }: { text: string; direction: "up" | "down" | "flat"; good?: boolean }) {
  const Icon = direction === "up" ? TrendingUp : direction === "down" ? TrendingDown : Minus;
  const toneClass =
    direction === "flat" || good === undefined ? "bg-surface-sunken text-muted" : good ? "bg-success-bg text-success" : "bg-danger-bg text-danger";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap", toneClass)}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {text}
    </span>
  );
}

const GRID_COLUMNS: Record<2 | 3 | 4 | 5, string> = {
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
  4: "sm:grid-cols-2 xl:grid-cols-4",
  5: "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5",
};

/** A row of tiles: one column on a phone, two from `sm`, and the full count on wide screens. */
export function KpiGrid({ children, columns = 4 }: { children: ReactNode; columns?: 2 | 3 | 4 | 5 }) {
  return <div className={cn("grid gap-4", GRID_COLUMNS[columns])}>{children}</div>;
}
