"use client";

import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type DragEvent, type ReactNode } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Building2,
  Calendar,
  CalendarCheck,
  ChartArea,
  ChartBar,
  ChartColumn,
  ChartLine,
  ChartPie,
  Check,
  ChevronDown,
  Circle,
  ClipboardCheck,
  Clock,
  Copy,
  Crosshair,
  EllipsisVertical,
  FileText,
  FolderKanban,
  GripVertical,
  Hash,
  IndianRupee,
  LayoutGrid,
  LifeBuoy,
  List,
  Lock,
  Pencil,
  Plus,
  Receipt,
  RefreshCw,
  ShoppingCart,
  SquareCheckBig,
  Table,
  Target,
  Trash2,
  Truck,
  UserRoundCheck,
  Users,
  UsersRound,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYER_CORNER, LAYER_MODAL } from "@/components/ui/layers";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { getChartWidget, saveDashboardLayout, type DashboardPresetOption } from "@/actions/dashboard";
import { toggleTaskDone } from "@/actions/task";
import {
  CHART_TYPES,
  CHART_TYPE_ORDER,
  DEFAULT_CHARTS,
  LAYOUT_MARKER,
  RANGES,
  SOURCES,
  decodeChart,
  encodeChart,
  rangeLabel,
  rangeStart,
  resultKey,
  type ChartCatalog,
  type ChartSpec,
  type ChartType,
  type KpiCard,
  type RangeKey,
  type SourceKey,
  type WidgetResult,
  type WidgetSize,
} from "@/lib/dashboard/charts";
import { CHART_HEIGHT, ChartView, Sparkline, TONE_CLASS, ToneIcon } from "@/components/dashboard/dashboard-charts";

/**
 * The dashboard: headline figures, then the widgets in the order this person put them — charts and
 * numbers only (owner, 23 Oct 2026: the older cards are gone; what they showed are widgets of their own).
 *
 * Everything is read on the server; this owns the arrangement, the builder, and drawing a chart in
 * another type. A chart's figures are keyed by what they depend on (`resultKey`), so changing its type
 * or width redraws what is already here, and only a new source, metric, filter or range asks again.
 */

type Item = { uid: string; spec: ChartSpec };
type Draft = { kind: "chart"; spec: ChartSpec };
type Modal = { mode: "add" | "edit"; uid?: string; draft: Draft };
type Toast = { msg: string; undo?: () => void; failed?: boolean };

const SOURCE_ICONS: Record<SourceKey, LucideIcon> = {
  tasks: SquareCheckBig,
  leads: Target,
  attendance: CalendarCheck,
  team: Users,
  approvals: ClipboardCheck,
  activity: Activity,
  customers: Building2,
  quotations: FileText,
  orders: ShoppingCart,
  targets: Crosshair,
  payments: IndianRupee,
  finance: Wallet,
  renewals: RefreshCw,
  support: LifeBuoy,
  projects: FolderKanban,
  expenses: Receipt,
  vendors: Truck,
};
const TYPE_ICONS: Record<ChartType, LucideIcon> = { bar: ChartColumn, line: ChartLine, area: ChartArea, hbar: ChartBar, donut: ChartPie, pie: Circle, number: Hash, table: Table, list: List };
const KPI_ICONS: Record<KpiCard["icon"], LucideIcon> = { tasks: SquareCheckBig, leads: UsersRound, attendance: UserRoundCheck, approvals: Clock };

/** Columns by the width the dashboard has, not the window's — the sidebar takes its share first. */
const SPAN: Record<WidgetSize, string> = { 1: "", 2: "@min-[640px]:col-span-2", 3: "@min-[640px]:col-span-2 @min-[1000px]:col-span-3" };
const KPI_COLS: Record<number, string> = { 1: "grid-cols-1", 2: "grid-cols-2", 3: "grid-cols-2 @min-[1000px]:grid-cols-3", 4: "grid-cols-2 @min-[1000px]:grid-cols-4" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
const newId = () => `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function itemsOf(entries: string[], catalog: ChartCatalog): Item[] {
  const out: Item[] = [];
  for (const entry of entries) {
    if (entry === LAYOUT_MARKER) continue;
    const spec = decodeChart(entry);
    // A chart whose source this person can no longer open stays out of sight (and out of the next save);
    // one already on the board (a department's layout naming a design chart) is there once.
    if (spec && catalog.sources.includes(spec.source) && !out.some((i) => i.uid === spec.id)) out.push({ uid: spec.id, spec });
  }
  return out;
}
const entryOf = (item: Item) => encodeChart(item.spec);

export function DashboardBoard({
  today,
  range,
  kpis,
  entries,
  defaults,
  results: initialResults,
  catalog,
  presets,
}: {
  /** The workspace's today, `yyyy-mm-dd`, for the range menu's dates. */
  today: string;
  range: RangeKey;
  kpis: KpiCard[];
  entries: string[];
  defaults: string[];
  results: Record<string, WidgetResult>;
  catalog: ChartCatalog;
  presets: DashboardPresetOption[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [saved, setSaved] = useState<Item[]>(() => itemsOf(entries, catalog));
  const [draft, setDraft] = useState<Item[] | null>(null);
  const [results, setResults] = useState<Record<string, WidgetResult | "loading">>(initialResults);
  const [done, setDone] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The page comes back with a new layout after a save or a range change. Synced while rendering, not in
  // an effect, so the old arrangement isn't painted for a frame first (as WidgetGrid does).
  const incoming = entries.join("|");
  const [syncedTo, setSyncedTo] = useState(incoming);
  if (incoming !== syncedTo) {
    setSyncedTo(incoming);
    setSaved(itemsOf(entries, catalog));
  }
  const [syncedResults, setSyncedResults] = useState(initialResults);
  if (initialResults !== syncedResults) {
    setSyncedResults(initialResults);
    setResults((prev) => ({ ...prev, ...initialResults }));
  }

  const editing = draft !== null;
  const list = draft ?? saved;
  const isMobile = width !== null && width < 640;
  const cols = width === null ? 3 : width < 640 ? 1 : width < 1000 ? 2 : 3;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.target instanceof Element && e.target.closest("[data-keep-open]")) return;
      setMenuFor(null);
      setRangeOpen(false);
      setPresetOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuFor(null);
      setRangeOpen(false);
      setPresetOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  /** Asks for the figures of every chart on screen — and the one in the builder — that has none yet. */
  const wanted = useMemo(() => {
    const specs = list.map((i) => i.spec);
    if (modal) specs.push(modal.draft.spec);
    return specs.filter((s) => !(resultKey(s, range) in results));
  }, [list, modal, range, results]);
  useEffect(() => {
    if (wanted.length === 0) return;
    const timer = setTimeout(() => {
      for (const spec of wanted) {
        const key = resultKey(spec, range);
        setResults((prev) => (key in prev ? prev : { ...prev, [key]: "loading" }));
        getChartWidget(spec, range)
          .then((r) => setResults((prev) => ({ ...prev, [key]: r })))
          .catch(() => setResults((prev) => ({ ...prev, [key]: { ok: false, error: "This chart couldn't be loaded." } })));
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [wanted, range]);

  function showToast(msg: string, undo?: () => void, failed = false) {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ msg, undo, failed });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  /** Saved in the background: the arrangement is already on screen, and it snapping back mid-request would read as failure. */
  function persist(next: Item[]) {
    startTransition(async () => {
      const res = await saveDashboardLayout(next.map(entryOf));
      if (!res.ok) showToast(res.error, undefined, true);
    });
  }
  function update(fn: (l: Item[]) => Item[]) {
    if (editing) setDraft((d) => fn(d!));
    else {
      const next = fn(saved);
      setSaved(next);
      persist(next);
    }
  }

  const setType = (uid: string, type: ChartType) => update((l) => l.map((i) => (i.uid === uid ? { ...i, spec: { ...i.spec, type } } : i)));
  const resize = (uid: string, size: WidgetSize) => update((l) => l.map((i) => (i.uid === uid ? { ...i, spec: { ...i.spec, size } } : i)));
  function remove(uid: string) {
    setMenuFor(null);
    if (editing) return setDraft((d) => d!.filter((i) => i.uid !== uid));
    const prev = saved;
    const next = prev.filter((i) => i.uid !== uid);
    setSaved(next);
    persist(next);
    showToast("Widget removed", () => {
      setToast(null);
      setSaved(prev);
      persist(prev);
    });
  }
  function duplicate(uid: string) {
    setMenuFor(null);
    update((l) => {
      const at = l.findIndex((i) => i.uid === uid);
      const src = l[at];
      if (!src) return l;
      const id = newId();
      const copy: Item = { uid: id, spec: { ...src.spec, id, filters: { ...src.spec.filters } } };
      return [...l.slice(0, at + 1), copy, ...l.slice(at + 1)];
    });
    if (!editing) showToast("Widget duplicated");
  }
  function move(uid: string, dir: -1 | 1) {
    setDraft((d) => {
      const a = [...d!];
      const i = a.findIndex((x) => x.uid === uid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= a.length) return d;
      [a[i], a[j]] = [a[j]!, a[i]!];
      return a;
    });
  }
  function drop(target: string) {
    if (dragId && dragId !== target) {
      setDraft((d) => {
        const a = [...d!];
        const from = a.findIndex((x) => x.uid === dragId);
        const toOrig = a.findIndex((x) => x.uid === target);
        const [it] = a.splice(from, 1);
        const to = a.findIndex((x) => x.uid === target);
        a.splice(from < toOrig ? to + 1 : to, 0, it!);
        return a;
      });
    }
    setDragId(null);
    setOverId(null);
  }

  const startEdit = () => {
    setDraft(saved.map((i) => ({ ...i })));
    setMenuFor(null);
    setRangeOpen(false);
  };
  const cancelEdit = () => {
    setDraft(null);
    setDragId(null);
    setOverId(null);
  };
  function saveEdit() {
    const next = draft!;
    setSaved(next);
    setDraft(null);
    persist(next);
    showToast("Layout saved");
  }
  const resetDefault = () => setDraft(itemsOf(defaults, catalog));
  function applyPreset(p: DashboardPresetOption) {
    setPresetOpen(false);
    // The design's charts, then what the department's layout names — as widgets (src/actions/dashboard.ts).
    setDraft(itemsOf([...DEFAULT_CHARTS.map(encodeChart), ...p.widgets], catalog));
  }

  function toggleTask(id: string, current: boolean) {
    setDone((d) => ({ ...d, [id]: !current }));
    startTransition(async () => {
      const res = await toggleTaskDone(id);
      if (!res.ok) {
        setDone((d) => ({ ...d, [id]: current }));
        showToast(res.error, undefined, true);
      }
    });
  }

  // ─── The builder ───────────────────────────────────────────────────────────

  function chartDraft(source: SourceKey, keep?: { range: ChartSpec["range"]; size: WidgetSize }): Draft {
    const metric = Object.keys(SOURCES[source].metrics)[0]!;
    return {
      kind: "chart",
      spec: { id: "draft", source, metric, type: SOURCES[source].metrics[metric]!.types[0]!, size: keep?.size ?? 1, range: keep?.range ?? "inherit", filters: {}, title: "" },
    };
  }
  function openAdd() {
    setMenuFor(null);
    if (catalog.sources.length) setModal({ mode: "add", draft: chartDraft(catalog.sources[0]!) });
  }
  function openEdit(uid: string) {
    setMenuFor(null);
    const item = list.find((i) => i.uid === uid);
    if (item) setModal({ mode: "edit", uid, draft: { kind: "chart", spec: { ...item.spec, filters: { ...item.spec.filters } } } });
  }
  function submitModal() {
    if (!modal) return;
    const d = modal.draft;
    if (modal.mode === "add") {
      const id = newId();
      update((l) => [...l, { uid: id, spec: { ...d.spec, id } }]);
      if (!editing) showToast("Widget added to dashboard");
    } else {
      update((l) => l.map((i) => (i.uid === modal.uid ? { ...i, spec: { ...d.spec, id: i.spec.id } } : i)));
      if (!editing) showToast("Widget updated");
    }
    setModal(null);
  }

  const kpiCount = Math.min(4, kpis.length);

  return (
    <div ref={rootRef} className="@container">
      {editing && (
        <div className="sticky top-14 z-10 -mx-4 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 border-y border-brand/25 bg-[color-mix(in_srgb,var(--brand)_8%,var(--surface))] px-4 py-2.5 md:-mx-6 md:px-6">
          <div className="flex min-w-0 flex-[1_1_280px] items-center gap-2.5">
            <LayoutGrid className="h-4 w-4 shrink-0 text-brand" />
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-text">Customizing dashboard</div>
              <div className="text-[12.5px] text-muted">
                {isMobile ? "Use the arrows to reorder. Changes apply when you save." : "Drag cards to reorder, use S / M / L to resize. Changes apply when you save."}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {presets.length > 0 && (
              <div data-keep-open className="relative">
                <button type="button" onClick={() => setPresetOpen((o) => !o)} className="flex h-8 items-center gap-1 px-2 text-[13px] text-brand hover:underline">
                  Use a layout <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {presetOpen && (
                  <div className="absolute right-0 top-9 z-30 w-56 rounded-[10px] border border-line bg-surface-raised p-1 shadow-lg">
                    <p className="px-2.5 pb-1 pt-1.5 text-xs text-muted">Set up by your admin</p>
                    {presets.map((p) => (
                      <button key={p.id} type="button" onClick={() => applyPreset(p)} className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-[13px] text-text hover:bg-surface-sunken">
                        {p.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <button type="button" onClick={resetDefault} className="h-8 px-2 text-[13px] text-brand hover:underline">
              Reset to default
            </button>
            <button type="button" onClick={cancelEdit} className="h-8 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-text hover:bg-surface-sunken">
              Cancel
            </button>
            <button type="button" onClick={saveEdit} className="h-8 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-contrast hover:brightness-110">
              Save layout
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 @min-[640px]:gap-4">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3.5">
          <div className="min-w-0 flex-[1_1_300px]">
            <h2 className="text-2xl font-semibold leading-tight tracking-[-0.015em] text-text">My Dashboard</h2>
            <p className="mt-0.5 text-sm text-muted">Here&apos;s what&apos;s happening in your workspace today.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div data-keep-open className="relative">
              <button
                type="button"
                onClick={() => setRangeOpen((o) => !o)}
                aria-expanded={rangeOpen}
                className="flex h-[38px] items-center gap-2 rounded-[9px] border border-line bg-surface pl-3 pr-[11px] text-[13px] font-medium text-text hover:bg-surface-sunken"
              >
                <Calendar className="h-[15px] w-[15px] text-muted" />
                {rangeLabel(range)}
                <ChevronDown className="h-3.5 w-3.5 text-subtle" />
              </button>
              {rangeOpen && (
                <div className={cn("absolute top-11 z-30 w-64 rounded-[10px] border border-line bg-surface-raised p-1 shadow-lg", isMobile ? "left-0" : "right-0")}>
                  {RANGES.map((r) => {
                    const selected = r.key === range;
                    return (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => {
                          setRangeOpen(false);
                          if (!selected) router.push(`/dashboard?range=${r.key}`, { scroll: false });
                        }}
                        className={cn("flex h-[34px] w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-text hover:bg-surface-sunken", selected && "bg-surface-sunken")}
                      >
                        <span className="flex w-4 text-brand">{selected && <Check className="h-[15px] w-[15px]" />}</span>
                        <span className={cn("flex-1", selected && "font-medium")}>{r.label}</span>
                        <span className="text-xs text-subtle">
                          {shortDay(rangeStart(today, r.key))} – {shortDay(today)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={openAdd}
              className="flex h-[38px] items-center gap-[7px] rounded-[9px] border border-line bg-surface px-[13px] text-[13px] font-medium text-text hover:bg-surface-sunken"
            >
              <Plus className="h-[15px] w-[15px]" />
              Add Widget
            </button>
            {!editing && (
              <button type="button" onClick={startEdit} className="flex h-[38px] items-center gap-[7px] rounded-[9px] bg-brand px-3.5 text-[13px] font-medium text-brand-contrast hover:brightness-110">
                <Pencil className="h-3.5 w-3.5" />
                Customize
              </button>
            )}
          </div>
        </div>

        {kpis.length > 0 && (
          <div className={cn("grid gap-3 @min-[640px]:gap-4", KPI_COLS[kpiCount])}>
            {kpis.map((k) => {
              const Icon = KPI_ICONS[k.icon];
              return (
                <Link key={k.key} href={k.href} className="flex min-w-0 items-start gap-3.5 rounded-xl border border-line bg-surface p-3.5 transition-colors hover:border-line-strong @min-[640px]:p-[18px]">
                  <span className="hidden h-11 w-11 flex-none place-items-center rounded-[10px] bg-brand-subtle text-brand @min-[640px]:grid">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate text-[13px] font-medium text-muted">{k.label}</span>
                    <span className="text-2xl font-semibold leading-[1.15] tracking-[-0.02em] tabular-nums text-text @min-[640px]:text-[28px]">{k.value}</span>
                    <span className={cn("flex min-w-0 items-center gap-1 text-[12.5px] font-medium", TONE_CLASS[k.tone])}>
                      <ToneIcon tone={k.tone} className="h-[13px] w-[13px] shrink-0" />
                      <span className="truncate">{k.delta}</span>
                    </span>
                  </div>
                  <div className="mb-[18px] hidden flex-none self-end @min-[1280px]:block">
                    <Sparkline values={k.spark} />
                  </div>
                </Link>
              );
            })}
          </div>
        )}

        {list.length === 0 && !editing && (
          <div className="rounded-xl border border-dashed border-line-strong bg-surface px-6 py-12 text-center">
            <div className="text-sm font-medium text-text">No widgets on this dashboard</div>
            <div className="mb-3.5 mt-1 text-[13px] text-muted">Add a chart from any module you have access to.</div>
            <button type="button" onClick={openAdd} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-contrast hover:brightness-110">
              <Plus className="h-[15px] w-[15px]" />
              Add Widget
            </button>
          </div>
        )}

        <div className="grid grid-flow-row-dense grid-cols-1 gap-3 @min-[640px]:grid-cols-2 @min-[640px]:gap-4 @min-[1000px]:grid-cols-3">
          {list.map((item, index) => {
            const size: WidgetSize = item.spec.size;
            const dragProps = editing && !isMobile
              ? {
                  draggable: true,
                  onDragStart: (e: DragEvent) => {
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox starts no drag at all without data on the transfer.
                    e.dataTransfer.setData("text/plain", item.uid);
                    setDragId(item.uid);
                  },
                  onDragOver: (e: DragEvent) => {
                    if (!dragId) return;
                    e.preventDefault();
                    if (overId !== item.uid) setOverId(item.uid);
                  },
                  onDrop: (e: DragEvent) => {
                    e.preventDefault();
                    drop(item.uid);
                  },
                  onDragEnd: () => {
                    setDragId(null);
                    setOverId(null);
                  },
                }
              : {};
            const controls = editing ? (
              <EditControls
                isMobile={isMobile}
                cols={cols}
                size={size}
                onSize={(n) => resize(item.uid, n)}
                onUp={index > 0 ? () => move(item.uid, -1) : undefined}
                onDown={index < list.length - 1 ? () => move(item.uid, 1) : undefined}
                onEdit={() => openEdit(item.uid)}
                onRemove={() => remove(item.uid)}
              />
            ) : null;
            const frame = cn(
              "relative min-w-0 transition-[box-shadow,opacity]",
              SPAN[size],
              dragId === item.uid && "opacity-45",
              overId === item.uid && dragId && dragId !== item.uid && "rounded-xl ring-2 ring-brand",
              editing && !isMobile && "cursor-grab",
              menuFor === item.uid && "z-[5]",
            );

            const spec = item.spec;
            const source = SOURCES[spec.source];
            const metric = source.metrics[spec.metric]!;
            const Icon = SOURCE_ICONS[spec.source];
            const result = results[resultKey(spec, range)];
            const multiType = metric.types.length > 1;
            const listLike = spec.type === "list" || spec.type === "table";
            return (
              <section
                key={item.uid}
                className={cn(frame, "flex flex-col rounded-xl border bg-surface", editing ? "border-dashed border-line-strong" : "border-line")}
                {...dragProps}
              >
                <div className="flex min-h-8 items-center gap-2 pl-[18px] pr-3 pt-3.5">
                  {editing && !isMobile && <GripVertical className="-ml-2 -mr-0.5 h-4 w-4 shrink-0 text-subtle" aria-label="Drag to reorder" />}
                  <Icon className="h-4 w-4 shrink-0 text-brand" />
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate text-[14.5px] font-semibold leading-[1.3] tracking-[-0.005em] text-text">{spec.title || metric.label}</h3>
                    {result && result !== "loading" && result.ok && result.subtitle && <div className="mt-px truncate text-xs text-subtle">{result.subtitle}</div>}
                  </div>
                  {!editing && multiType && (
                    <div className="relative flex-none">
                      <select
                        value={spec.type}
                        onChange={(e) => setType(item.uid, e.target.value as ChartType)}
                        aria-label="Chart type"
                        className="h-[30px] cursor-pointer appearance-none rounded-[7px] border border-line bg-surface pl-[9px] pr-[26px] text-[12.5px] text-text"
                      >
                        {metric.types.map((t) => (
                          <option key={t} value={t}>
                            {CHART_TYPES[t].label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2 top-2 h-3.5 w-3.5 text-subtle" />
                    </div>
                  )}
                  {!editing && !multiType && listLike && (
                    <Link href={source.href} className="whitespace-nowrap px-1 text-[13px] font-medium text-brand hover:underline">
                      View all
                    </Link>
                  )}
                  {controls}
                  {!editing && (
                    <div data-keep-open className="relative">
                      <button
                        type="button"
                        onClick={() => setMenuFor((m) => (m === item.uid ? null : item.uid))}
                        aria-label="Widget options"
                        aria-expanded={menuFor === item.uid}
                        className={cn("grid h-7 w-7 place-items-center rounded-[7px] text-muted hover:bg-surface-sunken hover:text-text", menuFor === item.uid && "bg-surface-sunken")}
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </button>
                      {menuFor === item.uid && (
                        <div className="absolute right-0 top-8 z-30 w-[188px] rounded-[10px] border border-line bg-surface-raised p-1 shadow-lg">
                          <MenuButton icon={Pencil} onClick={() => openEdit(item.uid)}>
                            Edit widget
                          </MenuButton>
                          <MenuButton icon={Copy} onClick={() => duplicate(item.uid)}>
                            Duplicate
                          </MenuButton>
                          <Link href={source.href} className="flex h-8 w-full items-center gap-[9px] rounded-md px-2.5 text-[13px] text-text hover:bg-surface-sunken">
                            <ArrowUpRight className="h-3.5 w-3.5 text-muted" />
                            {source.openLabel}
                          </Link>
                          <div className="mx-1.5 my-1 h-px bg-line" />
                          <button type="button" onClick={() => remove(item.uid)} className="flex h-8 w-full items-center gap-[9px] rounded-md px-2.5 text-left text-[13px] text-danger hover:bg-danger-bg">
                            <Trash2 className="h-3.5 w-3.5" />
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="min-h-0 flex-1 px-[18px] pb-4 pt-3.5">
                  <WidgetBody
                    result={result}
                    type={spec.type}
                    done={done}
                    onToggleTask={editing ? undefined : (id, current) => toggleTask(id, current)}
                  />
                </div>
              </section>
            );
          })}
          {editing && (
            <button
              type="button"
              onClick={openAdd}
              className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-[13px] font-medium text-muted hover:border-brand hover:bg-brand-subtle hover:text-brand"
            >
              <span className="grid h-8 w-8 place-items-center rounded-lg border border-current">
                <Plus className="h-4 w-4" />
              </span>
              Add Widget
            </button>
          )}
        </div>
      </div>

      {modal && (
        <WidgetBuilder
          modal={modal}
          setModal={setModal}
          editing={editing}
          isMobile={isMobile}
          cols={cols}
          range={range}
          catalog={catalog}
          result={results[resultKey(modal.draft.spec, range)]}
          chartDraft={chartDraft}
          onSubmit={submitModal}
          onRemove={() => {
            const uid = modal.uid!;
            setModal(null);
            remove(uid);
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          className={cn(
            "fixed bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-3.5 whitespace-nowrap rounded-lg bg-text px-3.5 py-2.5 text-[13px] text-bg shadow-lg",
            LAYER_CORNER,
          )}
        >
          {toast.failed ? <X className="h-[15px] w-[15px] text-danger" /> : <Check className="h-[15px] w-[15px] text-success" />}
          <span>{toast.msg}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className="font-medium text-[color-mix(in_srgb,var(--brand)_45%,var(--bg))] hover:underline">
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MenuButton({ icon: Icon, onClick, children }: { icon: LucideIcon; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="flex h-8 w-full items-center gap-[9px] rounded-md px-2.5 text-left text-[13px] text-text hover:bg-surface-sunken">
      <Icon className="h-3.5 w-3.5 text-muted" />
      {children}
    </button>
  );
}

function EditControls({
  isMobile,
  cols,
  size,
  onSize,
  onUp,
  onDown,
  onEdit,
  onRemove,
}: {
  isMobile: boolean;
  cols: number;
  size: WidgetSize;
  onSize: (n: WidgetSize) => void;
  onUp?: () => void;
  onDown?: () => void;
  onEdit?: () => void;
  onRemove: () => void;
}) {
  const span = Math.min(size, cols);
  return (
    <>
      {!isMobile && (
        <div title="Widget width" className="flex gap-0.5 rounded-[7px] bg-surface-sunken p-0.5">
          {([1, 2, 3] as const).slice(0, cols).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onSize(n)}
              aria-label={`Width: ${["small", "medium", "large"][n - 1]}`}
              aria-pressed={span === n}
              className={cn("h-[22px] w-6 rounded-[5px] text-[11.5px] font-medium", span === n ? "bg-surface text-text shadow-sm" : "text-muted")}
            >
              {["S", "M", "L"][n - 1]}
            </button>
          ))}
        </div>
      )}
      {isMobile && (
        <>
          <button type="button" onClick={onUp} disabled={!onUp} aria-label="Move up" className="grid h-7 w-7 place-items-center rounded-[7px] border border-line bg-surface text-muted disabled:opacity-40">
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onDown} disabled={!onDown} aria-label="Move down" className="grid h-7 w-7 place-items-center rounded-[7px] border border-line bg-surface text-muted disabled:opacity-40">
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </>
      )}
      {onEdit && (
        <button type="button" onClick={onEdit} aria-label="Edit widget" title="Edit widget" className="grid h-7 w-7 place-items-center rounded-[7px] text-muted hover:bg-surface-sunken hover:text-text">
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" onClick={onRemove} aria-label="Remove widget" title="Remove widget" className="grid h-7 w-7 place-items-center rounded-[7px] text-muted hover:bg-danger-bg hover:text-danger">
        <X className="h-[15px] w-[15px]" />
      </button>
    </>
  );
}

function WidgetBody({
  result,
  type,
  done,
  onToggleTask,
}: {
  result: WidgetResult | "loading" | undefined;
  type: ChartType;
  done?: Record<string, boolean>;
  onToggleTask?: (id: string, current: boolean) => void;
}) {
  if (!result || result === "loading") return <div className="animate-pulse rounded-lg bg-surface-sunken/70" style={{ height: CHART_HEIGHT }} />;
  if (!result.ok) {
    return (
      <div className="grid place-items-center px-4 text-center text-sm text-subtle" style={{ height: CHART_HEIGHT }}>
        {result.error}
      </div>
    );
  }
  // A task ticked here shows ticked straight away; the server catches up behind it.
  const data =
    result.data.kind === "tasks" && done ? { ...result.data, items: result.data.items.map((t) => ({ ...t, done: done[t.id] ?? t.done })) } : result.data;
  return (
    <ChartView
      type={type}
      data={data}
      onToggleTask={
        onToggleTask && data.kind === "tasks"
          ? (id) => onToggleTask(id, data.items.find((t) => t.id === id)?.done ?? false)
          : undefined
      }
    />
  );
}

// ─── Add / edit widget ───────────────────────────────────────────────────────

const FIELD = "h-9 w-full appearance-none rounded-lg border border-line bg-surface pl-2.5 pr-[30px] text-[13px] text-text";

function WidgetBuilder({
  modal,
  setModal,
  editing,
  isMobile,
  cols,
  range,
  catalog,
  result,
  chartDraft,
  onSubmit,
  onRemove,
}: {
  modal: Modal;
  setModal: (fn: (m: Modal | null) => Modal | null) => void;
  editing: boolean;
  isMobile: boolean;
  cols: number;
  range: RangeKey;
  catalog: ChartCatalog;
  result: WidgetResult | "loading" | undefined;
  chartDraft: (source: SourceKey, keep?: { range: ChartSpec["range"]; size: WidgetSize }) => Draft;
  onSubmit: () => void;
  onRemove: () => void;
}) {
  const close = () => setModal(() => null);
  const { titleId, containerRef } = useModalA11y(true, close);
  const d = modal.draft;
  const setDraft = (draft: Draft) => setModal((m) => (m ? { ...m, draft } : m));
  const patch = (p: Partial<ChartSpec>) => setModal((m) => (m ? { ...m, draft: { kind: "chart", spec: { ...m.draft.spec, ...p } } } : m));
  const wide = !isMobile;
  const isEdit = modal.mode === "edit";
  const title = isEdit ? "Edit widget" : "Add widget";
  const sources = catalog.sources;
  const selected = d.spec.source;
  const keep = { range: d.spec.range, size: d.spec.size };

  const spec = d.spec;
  const metric = SOURCES[spec.source].metrics[spec.metric]!;

  return createPortal(
    <div className={cn("fixed inset-0 flex items-center justify-center bg-black/35 animate-fade-in", LAYER_MODAL, isMobile ? "p-0" : "p-6")} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "flex max-h-full flex-col overflow-hidden border border-line bg-surface shadow-lg animate-scale-in",
          isMobile ? "h-full w-full rounded-none" : "h-[min(740px,100%)] w-[min(940px,100%)] rounded-[14px]",
        )}
      >
        <div className="flex flex-none items-start gap-3 border-b border-line py-3.5 pl-5 pr-4 pt-4">
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-[15px] font-semibold text-text">
              {title}
            </div>
            <div className="mt-0.5 text-[13px] text-muted">Choose a data source, metric and chart. The preview updates as you go.</div>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="grid h-[30px] w-[30px] place-items-center rounded-[7px] text-muted hover:bg-surface-sunken">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className={cn("grid min-h-0 flex-1 content-start overflow-y-auto", wide ? "grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]" : "grid-cols-1")}>
          <div className="flex min-w-0 flex-col gap-5 px-5 pb-[22px] pt-[18px]">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium text-text">Data source</span>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-subtle">
                  <Lock className="h-[11px] w-[11px]" />
                  Only modules you can access
                </span>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2">
                {sources.map((s) => {
                  const Icon = SOURCE_ICONS[s];
                  const on = s === selected;
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setDraft(chartDraft(s, keep))}
                      aria-pressed={on}
                      className={cn(
                        "flex h-[38px] items-center gap-2 rounded-lg border px-2.5 text-left text-[13px] font-medium",
                        on ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-text hover:bg-surface-sunken",
                      )}
                    >
                      <Icon className="h-[15px] w-[15px]" />
                      {SOURCES[s].label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] font-medium text-text">Metric</span>
              <div className="flex flex-col gap-1.5">
                {Object.entries(SOURCES[d.spec.source].metrics).map(([k, m]) => (
                  <Choice
                    key={k}
                    on={d.spec.metric === k}
                    label={m.label}
                    description={m.description}
                    onClick={() => patch({ metric: k, type: m.types.includes(d.spec.type) ? d.spec.type : m.types[0]!, ...(m.fixed ? { range: "inherit" as const } : {}) })}
                  />
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[12.5px] font-medium text-text">Chart type</span>
                <span className="text-[11.5px] text-subtle">Only types that suit this metric are enabled</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {CHART_TYPE_ORDER.map((t) => {
                  const ok = metric.types.includes(t);
                  const on = spec.type === t;
                  const Icon = TYPE_ICONS[t];
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={!ok}
                      title={ok ? undefined : "Not available for this metric"}
                      onClick={() => patch({ type: t })}
                      aria-pressed={on}
                      className={cn(
                        "flex h-8 items-center gap-1.5 rounded-[7px] border px-2.5 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-40",
                        on ? "border-brand bg-brand-subtle text-brand" : "border-line bg-surface text-text",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                      {CHART_TYPES[t].label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
              {/* A figure the range doesn't move (open tickets, this fiscal year) offers no range to pick. */}
              {!metric.fixed && (
                <Field label="Date range">
                  <select value={spec.range} onChange={(e) => patch({ range: e.target.value as ChartSpec["range"] })} className={FIELD}>
                    <option value="inherit">Match dashboard ({rangeLabel(range)})</option>
                    {RANGES.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {(catalog.filters[spec.source] ?? []).map((f) => (
                <Field key={f.key} label={f.label}>
                  <select value={spec.filters[f.key] ?? "all"} onChange={(e) => patch({ filters: { ...spec.filters, [f.key]: e.target.value } })} className={FIELD}>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ))}
            </div>

            <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="widget-title" className="text-[12.5px] font-medium text-text">
                  Title
                </label>
                <input
                  id="widget-title"
                  value={spec.title}
                  maxLength={80}
                  onChange={(e) => patch({ title: e.target.value })}
                  placeholder={metric.label}
                  className="h-9 min-w-0 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-text"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[12.5px] font-medium text-text">Width</span>
                <div className="flex h-9 gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
                  {(["Small", "Medium", "Large"] as const).map((label, i) => {
                    const n = (i + 1) as WidgetSize;
                    return (
                      <button
                        key={label}
                        type="button"
                        onClick={() => patch({ size: n })}
                        aria-pressed={spec.size === n}
                        className={cn("flex-1 rounded-md text-[12.5px] font-medium", spec.size === n ? "bg-surface text-text shadow-sm" : "text-muted")}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className={cn("flex min-w-0 flex-col gap-2.5 bg-bg px-5 pb-[22px] pt-[18px]", wide ? "border-l border-line" : "border-t border-line")}>
            <span className="text-[12.5px] font-medium text-text">Preview</span>
            <div className="rounded-xl border border-line bg-surface">
              <div className="flex items-center gap-2 px-[18px] pt-3.5">
                {(() => {
                  const Icon = SOURCE_ICONS[selected];
                  return <Icon className="h-4 w-4 shrink-0 text-brand" />;
                })()}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14.5px] font-semibold text-text">{spec.title || metric.label}</div>
                  <div className="mt-px truncate text-xs text-subtle">
                    {result && result !== "loading" && result.ok
                      ? result.subtitle || (metric.fixed ? "" : rangeLabel(spec.range === "inherit" ? range : spec.range))
                      : metric.fixed
                        ? ""
                        : rangeLabel(spec.range === "inherit" ? range : spec.range)}
                  </div>
                </div>
              </div>
              <div className="px-[18px] pb-4 pt-3.5">
                <WidgetBody result={result} type={spec.type} />
              </div>
            </div>
            <div className="text-xs text-muted">{`Spans ${Math.min(spec.size, cols)} of ${cols} column${cols === 1 ? "" : "s"} at this screen size.`}</div>
          </div>
        </div>

        <div className="flex flex-none flex-wrap items-center justify-between gap-2.5 border-t border-line py-3 pl-5 pr-4">
          {isEdit ? (
            <button type="button" onClick={onRemove} className="flex h-[34px] items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-danger hover:bg-danger-bg">
              <Trash2 className="h-3.5 w-3.5" />
              Remove widget
            </button>
          ) : (
            <span className="text-xs text-subtle">{editing ? "Added to your draft layout" : "Added to the end of your dashboard"}</span>
          )}
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={close} className="h-[34px] rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-text hover:bg-surface-sunken">
              Cancel
            </button>
            <button
              type="button"
              onClick={onSubmit}
              className="h-[34px] rounded-lg bg-brand px-3.5 text-[13px] font-medium text-brand-contrast hover:brightness-110 disabled:opacity-45"
            >
              {isEdit ? "Save changes" : "Add widget"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Choice({ on, label, description, onClick }: { on: boolean; label: string; description: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left", on ? "border-brand bg-brand-subtle" : "border-line bg-surface hover:bg-surface-sunken")}
    >
      <span className={cn("mt-px h-4 w-4 flex-none rounded-full bg-surface", on ? "border-[5px] border-brand" : "border-[1.5px] border-line-strong")} />
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-text">{label}</span>
        <span className="mt-px block text-xs text-muted">{description}</span>
      </span>
    </button>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-text">{label}</span>
      <span className="relative">
        {children}
        <ChevronDown className="pointer-events-none absolute right-2.5 top-[11px] h-3.5 w-3.5 text-subtle" />
      </span>
    </label>
  );
}
