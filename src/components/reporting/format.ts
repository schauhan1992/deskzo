import { shortRupees } from "@/lib/dashboard/charts";
import type { MetricUnit } from "@/lib/reporting/result";

/**
 * How report figures read (Reporting & Analytics): rupees short (₹3.11 Cr, ₹86.3 L), a calculated rate as a
 * percentage, days to one place, counts in Indian grouping. The exact figure is a hover away wherever it is shortened.
 */

export function formatMetric(value: number | null | undefined, unit: MetricUnit, opts: { short?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "currency":
      return opts.short === false ? `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : shortRupees(value, Math.abs(value) >= 1e7 ? 2 : 2);
    case "percent":
      return `${(value * 100).toFixed(1)}%`;
    case "days":
      return `${value.toFixed(1)} days`;
    default:
      return Math.abs(value) >= 1e7 ? `${(value / 1e7).toFixed(2).replace(/\.?0+$/, "")} Cr` : value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  }
}

/** An axis tick: shorter still. */
export function formatTick(value: number, unit: MetricUnit): string {
  if (unit === "currency") return shortRupees(value, 1).replace(" ", "");
  if (unit === "percent") return `${Math.round(value * 100)}%`;
  if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1).replace(/\.0$/, "")}k`;
  return String(Math.round(value * 10) / 10);
}

/** The change between two figures, as the score cards say it: "26.3%", "4.6 pts" for a rate. */
export function changeOf(value: number | null, previous: number | null, unit: MetricUnit): { text: string; up: boolean } | null {
  if (value === null || previous === null) return null;
  if (unit === "percent") {
    const pts = (value - previous) * 100;
    return { text: `${Math.abs(pts).toFixed(1)} pts`, up: pts >= 0 };
  }
  if (previous === 0) return value === 0 ? { text: "0%", up: true } : null;
  const pct = ((value - previous) / Math.abs(previous)) * 100;
  return { text: `${Math.abs(pct).toFixed(1)}%`, up: pct >= 0 };
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/** A relative time for lists: "10:42" today, "Yesterday", or the day. */
export function whenText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return `Today, ${at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (at.toDateString() === y.toDateString()) return "Yesterday";
  return at.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}
