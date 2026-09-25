/**
 * Grouped columns: for each period, the forecast beside what it is measured against — booked so far,
 * the target, last year.
 *
 * Hand-written SVG for the reasons `ReportChart` gives, and separate from it because that chart
 * draws one measure per period (or a composition, stacked), and a forecast is a comparison: four
 * different numbers about the same month, read side by side. Renders on the server — there is
 * nothing to interact with, and the table under it carries every figure.
 */

export type ChartSeries = { key: string; label: string; color: string; values: (number | null)[] };

const W = 960;
const H = 260;
const PAD = { top: 12, right: 8, bottom: 36, left: 8 };

export function compactInr(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `₹${(n / 1e7).toFixed(abs >= 1e8 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `₹${(n / 1e5).toFixed(abs >= 1e6 ? 0 : 1)}L`;
  if (abs >= 1e3) return `₹${Math.round(n / 1e3)}K`;
  return `₹${Math.round(n)}`;
}

export function ForecastChart({ labels, series, title }: { labels: string[]; series: ChartSeries[]; title: string }) {
  const max = Math.max(1, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const groupWidth = (W - PAD.left - PAD.right) / Math.max(1, labels.length);
  const barWidth = Math.min(28, (groupWidth * 0.8) / Math.max(1, series.length));
  const plotH = H - PAD.top - PAD.bottom;
  const peak = labels.reduce(
    (best, label, i) => {
      const v = series[0]?.values[i] ?? 0;
      return v > best.v ? { label, v } : best;
    },
    { label: "", v: -1 },
  );

  return (
    <figure className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full text-muted"
        role="img"
        aria-label={`${title}: ${series.map((s) => s.label).join(", ")} across ${labels.length} periods${peak.v >= 0 ? `. ${series[0]?.label} peaks in ${peak.label} at ${compactInr(peak.v)}` : ""}. Every figure is in the table below.`}
      >
        <line x1={PAD.left} x2={W - PAD.right} y1={H - PAD.bottom} y2={H - PAD.bottom} stroke="currentColor" strokeOpacity={0.3} />
        {labels.map((label, i) => {
          const x0 = PAD.left + i * groupWidth + (groupWidth - barWidth * series.length) / 2;
          return (
            <g key={label}>
              {series.map((s, j) => {
                const v = s.values[i];
                if (v === null || v === undefined) return null;
                const h = (Math.max(0, v) / max) * plotH;
                return (
                  <rect key={s.key} x={x0 + j * barWidth} y={H - PAD.bottom - h} width={barWidth - 2} height={h} rx={2} fill={s.color}>
                    <title>{`${label} — ${s.label}: ${compactInr(v)}`}</title>
                  </rect>
                );
              })}
              <text x={PAD.left + i * groupWidth + groupWidth / 2} y={H - 12} textAnchor="middle" fontSize={13} fill="currentColor">
                {label}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
