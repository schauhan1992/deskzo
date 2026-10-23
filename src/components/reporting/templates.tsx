"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Lock, Search } from "lucide-react";
import type { TemplateCard } from "@/actions/reporting";
import { cn } from "@/lib/utils";
import type { ChartKind } from "@/lib/reporting/definition";

/**
 * The shape of a template's main chart, drawn as a diagram — no axes, no figures. A template has no data of its own
 * until somebody makes a report from it, and a picture with numbers on it would be a made-up figure.
 */
export function TemplateThumb({ type, small }: { type: ChartKind; small?: boolean }) {
  const w = small ? 56 : 220;
  const h = small ? 36 : 110;
  const common = { width: w, height: h, viewBox: "0 0 100 50", "aria-hidden": true, preserveAspectRatio: "none" as const };
  switch (type) {
    case "bar":
      return (
        <svg {...common}>
          {[40, 32, 26, 20, 14].map((len, i) => (
            <rect key={i} x={8} y={4 + i * 9} width={len * 2} height={5} rx={1} fill="var(--brand)" opacity={1 - i * 0.12} />
          ))}
        </svg>
      );
    case "line":
    case "area":
      return (
        <svg {...common}>
          {type === "area" && <path d="M4 34 L20 28 L36 31 L52 20 L68 24 L84 12 L96 16 L96 48 L4 48 Z" fill="var(--brand)" opacity={0.15} />}
          <path d="M4 34 L20 28 L36 31 L52 20 L68 24 L84 12 L96 16" fill="none" stroke="var(--brand)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {type === "line" && <path d="M4 40 L20 36 L36 38 L52 30 L68 33 L84 27 L96 29" fill="none" stroke="var(--success)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </svg>
      );
    case "pie":
    case "donut":
      return (
        <svg width={small ? 36 : 110} height={small ? 36 : 110} viewBox="0 0 42 42" aria-hidden>
          {[
            { c: "var(--brand)", len: 45, off: 0 },
            { c: "var(--success)", len: 30, off: 45 },
            { c: "var(--warning)", len: 25, off: 75 },
          ].map((s) => (
            <circle key={s.c} cx={21} cy={21} r={15.9} fill="none" stroke={s.c} strokeWidth={type === "donut" ? 6 : 15.9} strokeDasharray={`${s.len} ${100 - s.len}`} strokeDashoffset={25 - s.off} />
          ))}
        </svg>
      );
    case "table":
    case "pivot":
      return (
        <svg {...common}>
          {[0, 1, 2, 3, 4].map((r) => (
            <g key={r}>
              <rect x={4} y={4 + r * 9} width={30} height={5} rx={1} fill="var(--text-subtle)" opacity={r === 0 ? 0.6 : 0.3} />
              {[0, 1, 2].map((c) => (
                <rect key={c} x={42 + c * 19} y={4 + r * 9} width={14} height={5} rx={1} fill={r === 0 ? "var(--text-subtle)" : "var(--brand)"} opacity={r === 0 ? 0.6 : 0.45} />
              ))}
            </g>
          ))}
        </svg>
      );
    case "score":
      return (
        <svg {...common}>
          <rect x={6} y={8} width={30} height={5} rx={1} fill="var(--text-subtle)" opacity={0.5} />
          <rect x={6} y={20} width={52} height={12} rx={2} fill="var(--brand)" opacity={0.8} />
          <path d="M66 30 L74 24 L82 27 L94 14" fill="none" stroke="var(--brand)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
      );
    default:
      // column and combo
      return (
        <svg {...common}>
          {[22, 30, 26, 36, 32, 40, 34].map((v, i) => (
            <rect key={i} x={6 + i * 13} y={48 - v} width={8} height={v} rx={1} fill="var(--brand)" opacity={0.85} />
          ))}
          {type === "combo" && <path d="M10 14 L23 12 L36 15 L49 10 L62 18 L75 16 L88 22" fill="none" stroke="var(--success)" strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </svg>
      );
  }
}

/** Report templates (design 1g): ready-made layouts over real fields, each opened in the builder as a copy. */
export function TemplateGallery({ templates, categories }: { templates: TemplateCard[]; categories: string[] }) {
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [openOnly, setOpenOnly] = useState(true);

  const pool = useMemo(() => templates.filter((t) => !openOnly || t.available), [templates, openOnly]);
  const shown = pool.filter((t) => (!category || t.category === category) && (!search.trim() || `${t.name} ${t.description} ${t.sourceLabel}`.toLowerCase().includes(search.trim().toLowerCase())));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold text-text">Report templates</h1>
        <p className="text-[13.5px] text-muted">Ready-made layouts that fill with your own data. Each opens in the builder so you can change anything.</p>
      </div>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search templates…" className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand" />
          </label>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Template categories">
            {[null, ...categories].map((c) => {
              const n = c ? pool.filter((t) => t.category === c).length : pool.length;
              return (
                <button
                  key={c ?? "all"}
                  type="button"
                  aria-pressed={category === c}
                  onClick={() => setCategory(c)}
                  className={cn("flex shrink-0 items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13.5px]", category === c ? "bg-brand-subtle font-medium text-brand" : "text-text hover:bg-surface-sunken")}
                >
                  {c ?? "All templates"}
                  <span className="text-[12px] text-subtle">{n}</span>
                </button>
              );
            })}
          </nav>
          <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[12.5px] text-text">
            <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--brand)]" />
            Only show templates for sources I can open
          </label>
        </aside>
        {shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line-strong px-6 py-14 text-center text-[13.5px] text-muted">
            {search ? "No templates match your search." : openOnly ? "No templates here use a source your role can open." : "No templates in this category."}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
            {shown.map((t) => (
              <article key={t.key} className={cn("flex flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-sm", !t.available && "opacity-70")}>
                <div className="grid h-[132px] place-items-center border-b border-line bg-surface-sunken/50">
                  <TemplateThumb type={t.preview.type} />
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <h2 className="text-[14.5px] font-semibold text-text">{t.name}</h2>
                  <p className="mt-1 flex-1 text-[13px] text-muted">{t.description}</p>
                  <div className="mt-3 flex items-center gap-2">
                    <span className="rounded-full border border-line px-2 py-0.5 text-[12px] text-muted">{t.sourceLabel}</span>
                    <span className="text-[12px] text-subtle">{t.charts} charts</span>
                    {t.available ? (
                      <Link href={`/reports/new?template=${t.key}`} className="ml-auto inline-flex h-8 items-center rounded-base bg-brand-subtle px-3 text-[13px] font-medium text-brand hover:brightness-105">
                        Use template
                      </Link>
                    ) : (
                      <span className="ml-auto inline-flex items-center gap-1 text-[12px] text-subtle">
                        <Lock className="h-3.5 w-3.5" />
                        {t.lockedReason}
                      </span>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
