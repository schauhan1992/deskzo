/**
 * The dashboard's chart widgets: what can be charted, how, and how a chart is kept.
 *
 * Shared by the server (which reads the figures, src/lib/dashboard/data.ts) and the browser (which draws
 * them and builds new ones, src/components/dashboard/dashboard-board.tsx) — so nothing here may import
 * a server module.
 *
 * ## Kept in the array the dashboard already had
 *
 * A chart is an entry in `User.dashboardWidgets`, beside the older card keys ("notes", "renewals"…),
 * written as `chart:` and a query string. That array is already the dashboard's order and selection in
 * one, so a chart sits among the cards in the order somebody put it, and nothing needed a new column —
 * which would have meant every workspace's database migrating before the dashboard could open.
 *
 * `layout:2` in the array says it was saved by this dashboard. A list saved before it had charts gets
 * the default charts put in front of what it held, once; after that, removing a chart keeps it removed.
 */

export type ChartType = "bar" | "line" | "area" | "hbar" | "donut" | "pie" | "number" | "table" | "list";
export type RangeKey = "7d" | "30d" | "90d" | "qtd" | "ytd";
export type WidgetSize = 1 | 2 | 3;
export type SourceKey = "tasks" | "leads" | "attendance" | "team" | "approvals" | "activity";

export type ChartSpec = {
  id: string;
  source: SourceKey;
  metric: string;
  type: ChartType;
  size: WidgetSize;
  /** The dashboard's own range, or one of the widget's own. */
  range: RangeKey | "inherit";
  filters: Record<string, string>;
  /** Empty for the metric's own name. */
  title: string;
};

export const CHART_TYPES: Record<ChartType, { label: string }> = {
  bar: { label: "Column Chart" },
  line: { label: "Line Chart" },
  area: { label: "Area Chart" },
  hbar: { label: "Bar Chart" },
  donut: { label: "Donut Chart" },
  pie: { label: "Pie Chart" },
  number: { label: "Number" },
  table: { label: "Table" },
  list: { label: "List" },
};
export const CHART_TYPE_ORDER = Object.keys(CHART_TYPES) as ChartType[];

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "qtd", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
];
export const DEFAULT_RANGE: RangeKey = "30d";

const DAY_MS = 86_400_000;
/** A `yyyy-mm-dd` moved by whole days. */
export const shiftDay = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** The first day a range covers, ending today (`yyyy-mm-dd`, the workspace's). The quarter and year are the calendar's. */
export function rangeStart(today: string, range: RangeKey): string {
  const [year, month] = today.split("-").map(Number) as [number, number];
  if (range === "7d") return shiftDay(today, -6);
  if (range === "30d") return shiftDay(today, -29);
  if (range === "90d") return shiftDay(today, -89);
  if (range === "qtd") return `${year}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
  return `${year}-01-01`;
}
export const rangeLabel = (key: RangeKey) => RANGES.find((r) => r.key === key)?.label ?? key;
export const isRangeKey = (v: unknown): v is RangeKey => RANGES.some((r) => r.key === v);

/** A filter's choices. "all" is always first and always means "everything this person may see". */
export type FilterDef = { key: string; label: string; options: { value: string; label: string }[] };

/** Filters whose options come from the workspace — its departments — filled in by the server. */
export const DEPARTMENT_FILTER = "dept";

export type MetricDef = { label: string; description: string; types: ChartType[] };
export type SourceDef = {
  label: string;
  /** Where "Open …" in the widget's menu goes. */
  href: string;
  openLabel: string;
  filters: FilterDef[];
  metrics: Record<string, MetricDef>;
};

const WHOSE = (label: string, team: string, mine: string): FilterDef => ({
  key: "whose",
  label,
  options: [
    { value: "all", label: "Everyone" },
    { value: "team", label: team },
    { value: "me", label: mine },
  ],
});
const DEPARTMENT: FilterDef = { key: DEPARTMENT_FILTER, label: "Department", options: [{ value: "all", label: "All departments" }] };

export const SOURCES: Record<SourceKey, SourceDef> = {
  tasks: {
    label: "Tasks",
    href: "/tasks",
    openLabel: "Open Tasks",
    filters: [WHOSE("Assignee", "My team", "Assigned to me")],
    metrics: {
      completion: { label: "Task Completion Trend", description: "Completed and pending tasks over time", types: ["bar", "line", "area"] },
      priority: { label: "Tasks by Priority", description: "Open tasks grouped by priority", types: ["hbar", "bar", "donut", "pie"] },
      upcoming: { label: "Upcoming Tasks", description: "Next tasks due, with priority", types: ["list"] },
      total: { label: "Total Tasks", description: "Tasks created in the period", types: ["number"] },
    },
  },
  leads: {
    label: "Leads",
    href: "/leads",
    openLabel: "Open Leads",
    filters: [WHOSE("Owner", "My team", "My leads")],
    metrics: {
      status: { label: "Lead Status", description: "Open leads by pipeline stage", types: ["donut", "pie", "hbar", "bar"] },
      source: { label: "Leads by Source", description: "Where new leads came from", types: ["donut", "pie", "bar", "hbar"] },
      recent: { label: "Recent Leads", description: "Latest leads with status and owner", types: ["table"] },
      open: { label: "Open Leads", description: "Leads not yet won or lost", types: ["number"] },
    },
  },
  attendance: {
    label: "Attendance",
    href: "/people/attendance",
    openLabel: "Open Attendance",
    filters: [DEPARTMENT],
    metrics: {
      overview: { label: "Attendance Overview", description: "Present, late, absent and on-leave headcount", types: ["area", "line", "bar"] },
      rate: { label: "Attendance Rate", description: "Share of working days attended", types: ["number"] },
    },
  },
  team: {
    label: "Team",
    href: "/tasks",
    openLabel: "Open Tasks",
    filters: [DEPARTMENT],
    metrics: {
      performance: { label: "Team Performance", description: "On-time completion rate per person", types: ["bar", "hbar", "table"] },
    },
  },
  approvals: {
    label: "Approvals",
    href: "/approvals",
    openLabel: "Open Approvals",
    filters: [],
    metrics: {
      byType: { label: "Pending Approvals by Type", description: "Requests waiting on your decision", types: ["donut", "pie", "hbar"] },
      pending: { label: "Pending Approvals", description: "Total requests waiting on your decision", types: ["number"] },
    },
  },
  activity: {
    label: "Activity",
    href: "/activity",
    openLabel: "Open Activity log",
    filters: [],
    metrics: {
      recent: { label: "Recent Activities", description: "Latest events from modules you can access", types: ["list"] },
    },
  },
};
export const SOURCE_ORDER = Object.keys(SOURCES) as SourceKey[];
export const isSourceKey = (v: unknown): v is SourceKey => typeof v === "string" && v in SOURCES;

/** What the dashboard opens with for somebody who has never arranged it, before what they may see narrows it. */
export const DEFAULT_CHARTS: ChartSpec[] = [
  chart("d1", "tasks", "completion", "bar"),
  chart("d2", "leads", "status", "donut"),
  chart("d3", "attendance", "overview", "area"),
  chart("d4", "tasks", "priority", "hbar"),
  chart("d5", "team", "performance", "bar"),
  chart("d6", "activity", "recent", "list"),
  // Your own, not everybody's you may see: a manager's next five would otherwise be their team's.
  { ...chart("d7", "tasks", "upcoming", "list"), filters: { whose: "me" } },
  chart("d8", "leads", "source", "donut"),
  chart("d9", "leads", "recent", "table"),
];

/**
 * The older cards these charts stand in for. Left out of the default beside the charts — "My open tasks"
 * and "Latest activity" twice over is two of the same — but still there to add back.
 */
export const SUPERSEDED_CARDS = new Set(["tasks", "leads", "recentLeads", "activity"]);

function chart(id: string, source: SourceKey, metric: string, type: ChartType, size: WidgetSize = 1): ChartSpec {
  return { id, source, metric, type, size, range: "inherit", filters: {}, title: "" };
}

// ─── Kept as strings ─────────────────────────────────────────────────────────

export const LAYOUT_MARKER = "layout:2";
const PREFIX = "chart:";

export const isChartEntry = (entry: string) => entry.startsWith(PREFIX);

export function encodeChart(spec: ChartSpec): string {
  const q = new URLSearchParams({ id: spec.id, s: spec.source, m: spec.metric, t: spec.type, z: String(spec.size), r: spec.range });
  if (spec.title) q.set("title", spec.title);
  for (const [k, v] of Object.entries(spec.filters)) if (v && v !== "all") q.set(`f.${k}`, v);
  return PREFIX + q.toString();
}

/**
 * A kept entry back as a chart, or null for anything that isn't a chart this dashboard can draw — a
 * metric since removed, a type the metric no longer takes. Never throws: this reads what was saved.
 */
export function decodeChart(entry: string): ChartSpec | null {
  if (!isChartEntry(entry)) return null;
  const q = new URLSearchParams(entry.slice(PREFIX.length));
  return validChart({
    id: q.get("id"),
    source: q.get("s"),
    metric: q.get("m"),
    type: q.get("t"),
    size: Number(q.get("z")),
    range: q.get("r"),
    title: q.get("title") ?? "",
    filters: Object.fromEntries([...q.entries()].filter(([k]) => k.startsWith("f.")).map(([k, v]) => [k.slice(2), v])),
  });
}

/** A chart as it may be kept — anything a browser sent, checked field by field. */
export function validChart(input: unknown): ChartSpec | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[\w-]{1,40}$/.test(o.id)) return null;
  if (!isSourceKey(o.source)) return null;
  const source = SOURCES[o.source];
  if (typeof o.metric !== "string" || !Object.hasOwn(source.metrics, o.metric)) return null;
  const metric = source.metrics[o.metric]!;
  const type = metric.types.includes(o.type as ChartType) ? (o.type as ChartType) : metric.types[0]!;
  const size = ([1, 2, 3] as const).find((n) => n === o.size) ?? 1;
  const range = o.range === "inherit" || isRangeKey(o.range) ? (o.range as ChartSpec["range"]) : "inherit";
  const title = typeof o.title === "string" ? o.title.trim().slice(0, 80) : "";
  const filters: Record<string, string> = {};
  if (o.filters && typeof o.filters === "object") {
    for (const f of source.filters) {
      const v = (o.filters as Record<string, unknown>)[f.key];
      // Department ids are the workspace's; their shape is all that can be checked here.
      if (typeof v === "string" && v !== "all" && /^[\w-]{1,40}$/.test(v)) filters[f.key] = v;
    }
  }
  return { id: o.id, source: o.source, metric: o.metric, type, size, range, filters, title };
}

// ─── The figures, as the server hands them over ──────────────────────────────

/** A series over time. `keys` are days (`yyyy-mm-dd`) or, for the year, months (`yyyy-mm`). */
export type SeriesData = {
  kind: "series";
  grain: "day" | "month";
  keys: string[];
  /** Whether a week's figure is the days added up, or their average — headcount is the second. */
  combine: "sum" | "avg";
  /** Drawn stacked when shown as columns. */
  stacked: boolean;
  series: { name: string; values: number[] }[];
};
export type CategoryData = { kind: "category"; items: { label: string; value: number }[] };
export type NumberData = { kind: "number"; value: string; delta: string | null; tone: Tone };
export type TaskListData = {
  kind: "tasks";
  items: { id: string; title: string; priority: string | null; due: string | null; dueSoon: boolean; done: boolean }[];
};
export type ActivityListData = {
  kind: "activity";
  items: { id: string; icon: ActivityIcon; title: string; sub: string; time: string }[];
  ownOnly: boolean;
};
export type LeadTableData = {
  kind: "leads";
  rows: { id: string; href: string; name: string; company: string; status: string; owner: string; date: string }[];
};
export type TeamData = { kind: "team"; rows: { name: string; initials: string; done: number; onTime: number }[] };
export type ChartData = SeriesData | CategoryData | NumberData | TaskListData | ActivityListData | LeadTableData | TeamData;

export type Tone = "up" | "down" | "warn" | "flat";
export type ActivityIcon = "sign-in" | "read" | "security" | "device" | "other";

/** What a widget is drawn from: its figures, or why there are none. */
export type WidgetResult = { ok: true; data: ChartData; subtitle: string } | { ok: false; error: string };

export type KpiCard = {
  key: string;
  label: string;
  icon: "tasks" | "leads" | "attendance" | "approvals";
  value: string;
  delta: string;
  tone: Tone;
  href: string;
  spark: number[];
};

/** The data sources this person may chart, with the workspace's own filter choices filled in. */
export type ChartCatalog = {
  sources: SourceKey[];
  filters: Partial<Record<SourceKey, FilterDef[]>>;
};

/**
 * What a chart's figures depend on — never its type, title or width, so switching a column chart to a
 * line redraws what is already in hand instead of asking the server again.
 */
export function resultKey(spec: ChartSpec, dashboardRange: RangeKey): string {
  const filters = Object.entries(spec.filters).filter(([, v]) => v && v !== "all").sort();
  return JSON.stringify([spec.source, spec.metric, spec.range === "inherit" ? dashboardRange : spec.range, filters, spec.range === "inherit"]);
}

/** The days a week is drawn from, for a range of daily figures shown as columns. */
export function weekly(data: SeriesData): SeriesData {
  if (data.grain !== "day") return data;
  const groups: number[][] = [];
  for (let i = 0; i < data.keys.length; i += 7) groups.push(Array.from({ length: Math.min(7, data.keys.length - i) }, (_, j) => i + j));
  const fold = (values: number[], g: number[]) => {
    const total = g.reduce((a, i) => a + values[i]!, 0);
    return data.combine === "avg" ? Math.round((total / g.length) * 10) / 10 : total;
  };
  return {
    ...data,
    keys: groups.map((g) => data.keys[g[0]!]!),
    series: data.series.map((s) => ({ ...s, values: groups.map((g) => fold(s.values, g)) })),
  };
}
