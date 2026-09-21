import Link from "next/link";
import { Info } from "lucide-react";
import type { listTargets } from "@/actions/target";
import { Badge, Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { formatMetric, metricByKey, whatIsNeeded } from "@/lib/targets/metrics";
import { SchemePicker } from "@/components/targets/scheme-picker";

type Target = Awaited<ReturnType<typeof listTargets>>[number];

/**
 * One target, and how it's going.
 *
 * Built around pace rather than percentage. "60%" tells somebody almost nothing on its own — the
 * two things that matter are whether that is ahead or behind for this point in the period, and what
 * the rest of it has to look like. Both are said in words, because a bar and a number leave the
 * reader doing arithmetic about their own performance.
 */
export function TargetCard({
  target,
  showWho,
  schemes,
}: {
  target: Target;
  showWho?: boolean;
  /** Passed only where the viewer may change targets; omitted, the picker is not offered. */
  schemes?: { id: string; name: string; metric: string; active: boolean }[];
}) {
  const metric = metricByKey[target.metric];
  const p = target.progress;
  // Capped only for the bar's width — the figure itself still reads 140% when it is.
  const barWidth = Math.min(100, Math.max(0, p.percent));

  return (
    <Card className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-text">{metric.label}</span>
            <Badge tone={p.tone}>{p.label}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-subtle">
            {target.label}
            {showWho && (
              <>
                {" · "}
                {target.scope === "USER" && target.user ? (
                  <Link href={`/targets/${target.user.id}`} className="text-brand hover:underline">
                    {target.user.name}
                  </Link>
                ) : target.scope === "DEPARTMENT" ? (
                  `${target.department?.name ?? "A team"} — whole team`
                ) : (
                  "Whole company"
                )}
              </>
            )}
          </p>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums text-text">
            {formatMetric(p.achieved, metric.unit)}
          </div>
          <div className="text-xs text-subtle">of {formatMetric(p.target, metric.unit)}</div>
        </div>
      </div>

      {/* The bar carries two marks: what has been done, and where the period has got to. The gap
          between them is the whole story. */}
      <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={`h-full rounded-full ${
            p.tone === "green" ? "bg-success" : p.tone === "red" ? "bg-danger" : p.tone === "amber" ? "bg-warning" : "bg-line-strong"
          }`}
          style={{ width: `${barWidth}%` }}
        />
        {p.elapsedPercent > 0 && p.elapsedPercent < 100 && (
          <span
            className="absolute top-0 h-full w-px bg-text/50"
            style={{ left: `${p.elapsedPercent}%` }}
            aria-hidden
          />
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 text-xs">
        <span className="tabular-nums text-muted">{Math.round(p.percent)}% done</span>
        <span className="tabular-nums text-subtle">
          {p.daysLeft > 0 ? `${p.daysLeft} of ${p.daysTotal} days left` : `Ended ${formatDate(target.toDate)}`}
        </span>
      </div>

      <p className="mt-2 text-sm text-muted">{whatIsNeeded(p, metric.unit)}</p>

      {/* Pace stated explicitly where somebody is off it — the number they'd otherwise work out. */}
      {(p.status === "BEHIND" || p.status === "AT_RISK" || p.status === "AHEAD") && (
        <p className="mt-1 text-xs text-subtle">
          {p.aheadBy >= 0 ? "Ahead of" : "Behind"} an even run rate by{" "}
          {formatMetric(Math.abs(p.aheadBy), metric.unit)} — {formatMetric(p.expectedByNow, metric.unit)} would be par
          by today.
        </p>
      )}

      <details className="group mt-2">
        <summary className="flex cursor-pointer items-center gap-1 text-xs text-subtle hover:text-text">
          <Info className="h-3 w-3" />
          What counts
        </summary>
        <p className="mt-1 text-xs text-muted">{metric.counts}</p>
        {metric.excludes && <p className="mt-0.5 text-xs text-subtle">Not counted: {metric.excludes}</p>}
      </details>

      {target.note && <p className="mt-2 text-xs italic text-subtle">{target.note}</p>}

      {schemes && (
        <SchemePicker
          targetId={target.id}
          metric={target.metric}
          current={target.incentiveSchemeId ?? null}
          schemes={schemes}
        />
      )}
    </Card>
  );
}
