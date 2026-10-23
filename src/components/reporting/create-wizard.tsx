"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, FilePlus2, Lock, Search } from "lucide-react";
import { createReport, previewSource, type TemplateCard } from "@/actions/reporting";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { DateRange } from "@/lib/reporting/definition";
import type { CatalogSource } from "@/lib/reporting/sources";
import { DateRangeMenu } from "./controls";
import { TemplateThumb } from "./templates";

type Open = Extract<CatalogSource, { available: true }>;
type Preview = { rows: number; capped: boolean; source: Open } | "loading" | { error: string } | null;

const STEPS = [
  { title: "Data source", hint: "What it reads" },
  { title: "Starting point", hint: "Blank or template" },
  { title: "Details", hint: "Name, date range, access" },
] as const;

/**
 * Create report (the approved design's 1b): pick a source this person can open — the rest are shown locked with
 * the reason — then start blank or from one of its templates, then name it. The server makes it only over a source
 * they can open (src/actions/reporting.ts createReport) and the builder opens on it.
 */
export function CreateWizard({ sources, templates, groups, initialTemplate, today, hasDepartment }: { sources: CatalogSource[]; templates: TemplateCard[]; groups: string[]; initialTemplate: string | null; today: string; hasDepartment: boolean }) {
  const router = useRouter();
  const preset = initialTemplate ? templates.find((t) => t.key === initialTemplate && t.available) : undefined;
  const [step, setStep] = useState<0 | 1 | 2>(preset ? 2 : 0);
  const [sourceKey, setSourceKey] = useState<string | null>(preset?.source ?? sources.find((s) => s.available)?.key ?? null);
  const [start, setStart] = useState<string>(preset?.key ?? "blank");
  const [search, setSearch] = useState("");
  const [name, setName] = useState(preset?.name ?? "");
  const [description, setDescription] = useState("");
  const [range, setRange] = useState<DateRange>({ preset: "thisFy" });
  const [access, setAccess] = useState<"none" | "view" | "edit">("none");
  const [preview, setPreview] = useState<Preview>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const source = sources.find((s) => s.key === sourceKey);
  const open = source?.available ? source : null;
  const forSource = templates.filter((t) => t.source === sourceKey && t.available);
  const template = start === "blank" ? null : templates.find((t) => t.key === start);

  // How many rows this person can see in the source, and its fields — the panel beside the list.
  useEffect(() => {
    if (!sourceKey || !open) return;
    let live = true;
    const t = setTimeout(() => {
      setPreview("loading");
      previewSource({ source: sourceKey })
        .then((res) => live && setPreview(res.ok ? res.data : { error: res.error }))
        .catch(() => live && setPreview({ error: "Couldn't read the source. Try again." }));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [sourceKey, open]);

  function next() {
    setError(null);
    if (step === 0) {
      if (!open) return setError("Pick a source you can open.");
      if (template && template.source !== sourceKey) setStart("blank");
      return setStep(1);
    }
    if (step === 1) {
      if (!name.trim()) setName(template?.name ?? `${open?.label ?? "New"} report`);
      return setStep(2);
    }
    void create();
  }

  async function create() {
    if (!open) return;
    if (!name.trim()) return setError("Name the report.");
    setCreating(true);
    setError(null);
    try {
      const res = await createReport({
        name: name.trim(),
        description: description.trim(),
        source: open.key,
        ...(template ? { templateKey: template.key } : {}),
        ...(open.snapshot ? {} : { dateRange: range }),
        shareWithDepartment: hasDepartment ? access : "none",
      });
      if (!res.ok) {
        setError(res.error);
        setCreating(false);
        return;
      }
      router.push(`/reports/${res.data.id}/edit`);
    } catch {
      setError("Couldn't create the report. Check your connection and try again.");
      setCreating(false);
    }
  }

  const q = search.trim().toLowerCase();
  const card = (selected: boolean, locked: boolean) =>
    cn("flex min-h-[72px] items-center gap-3 rounded-xl border p-3 text-left", locked ? "cursor-not-allowed border-line opacity-60" : selected ? "border-brand bg-brand-subtle/50 ring-2 ring-brand/20" : "border-line hover:border-line-strong");

  return (
    <div className="mx-auto max-w-[1200px]">
      <div className="mb-4">
        <Link href="/reports" className="text-[12.5px] text-muted hover:text-text hover:underline">
          Reporting &amp; Analytics
        </Link>
        <h1 className="text-[22px] font-semibold text-text">Create report</h1>
      </div>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
        <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
          {/* Steps */}
          <ol className="flex gap-1 overflow-x-auto border-b border-line p-3 lg:flex-col lg:border-b-0 lg:border-r lg:p-4">
            {STEPS.map((s, i) => {
              const done = i < step;
              const here = i === step;
              const sub = i === 0 ? (open?.label ?? s.hint) : i === 1 ? (step > 1 ? (template?.name ?? "Blank report") : s.hint) : s.hint;
              return (
                <li key={s.title} className="shrink-0">
                  <button type="button" disabled={i > step} onClick={() => setStep(i as 0 | 1 | 2)} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left", here ? "bg-brand-subtle" : "hover:bg-surface-sunken disabled:hover:bg-transparent")}>
                    <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[12px] font-semibold", here ? "border-brand bg-brand text-brand-contrast" : done ? "border-success bg-success text-white" : "border-line text-muted")}>
                      {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </span>
                    <span>
                      <span className={cn("block text-[13.5px] font-medium", here ? "text-brand" : "text-text")}>{s.title}</span>
                      <span className="block max-w-[160px] truncate text-[12px] text-subtle">{sub}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>

          {/* The step */}
          <div className={cn("min-w-0 p-5", step !== 0 && "lg:col-span-2")}>
            {step === 0 && (
              <>
                <h2 className="text-[15px] font-semibold text-text">Choose a data source</h2>
                <p className="text-[13px] text-muted">Pick what the report reads from. Sources your role can&apos;t open are shown locked.</p>
                <label className="relative mt-3 block">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sources…" className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2.5 text-[13px] text-text outline-none focus:border-brand" />
                </label>
                {groups.map((g) => {
                  const list = sources.filter((s) => s.group === g && (!q || `${s.label} ${s.description}`.toLowerCase().includes(q)));
                  if (!list.length) return null;
                  return (
                    <div key={g} className="mt-4">
                      <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-subtle">{g}</p>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                        {list.map((s) => (
                          <button key={s.key} type="button" disabled={!s.available} aria-pressed={sourceKey === s.key} onClick={() => setSourceKey(s.key)} className={card(sourceKey === s.key, !s.available)}>
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-sunken text-subtle">{s.available ? <FilePlus2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}</span>
                            <span className="min-w-0">
                              <span className="block text-[13.5px] font-medium text-text">{s.label}</span>
                              <span className="block text-[12px] text-subtle">{s.available ? (s.snapshot ? "As of today" : `${s.measures.length} metrics · ${s.dimensions.length} dimensions`) : s.lockedReason}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </>
            )}

            {step === 1 && open && (
              <>
                <h2 className="text-[15px] font-semibold text-text">Starting point</h2>
                <p className="text-[13px] text-muted">Start with an empty page over {open.label.toLowerCase()}, or with a template you can change.</p>
                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <button type="button" aria-pressed={start === "blank"} onClick={() => setStart("blank")} className={cn(card(start === "blank", false), "min-h-[120px] flex-col items-start")}>
                    <FilePlus2 className="h-5 w-5 text-brand" />
                    <span className="block text-[14px] font-medium text-text">Blank report</span>
                    <span className="block text-[12.5px] text-muted">One empty page. Add charts from the fields.</span>
                  </button>
                  {forSource.map((t) => (
                    <button key={t.key} type="button" aria-pressed={start === t.key} onClick={() => setStart(t.key)} className={cn(card(start === t.key, false), "min-h-[120px] flex-col items-start")}>
                      <span className="text-brand">
                        <TemplateThumb type={t.preview.type} small />
                      </span>
                      <span className="block text-[14px] font-medium text-text">{t.name}</span>
                      <span className="block text-[12.5px] text-muted">
                        {t.description} · {t.charts} charts
                      </span>
                    </button>
                  ))}
                </div>
                {forSource.length === 0 && <p className="mt-3 text-[12.5px] text-subtle">There are no templates over {open.label.toLowerCase()} yet.</p>}
              </>
            )}

            {step === 2 && open && (
              <div className="max-w-xl space-y-4">
                <h2 className="text-[15px] font-semibold text-text">Details</h2>
                <label className="block text-[12.5px] font-medium text-text">
                  Name
                  <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13.5px] font-normal text-text" />
                </label>
                <label className="block text-[12.5px] font-medium text-text">
                  Description <span className="font-normal text-subtle">(optional)</span>
                  <textarea value={description} maxLength={400} rows={2} onChange={(e) => setDescription(e.target.value)} placeholder={template?.description ?? "What this report is for"} className="mt-1 w-full rounded-lg border border-line bg-surface px-2.5 py-2 text-[13.5px] font-normal text-text" />
                </label>
                {!open.snapshot ? (
                  <div>
                    <p className="text-[12.5px] font-medium text-text">Date range</p>
                    <div className="mt-1">
                      <DateRangeMenu value={range} today={today} onChange={setRange} align="start" />
                    </div>
                    <p className="mt-1 text-[12px] text-subtle">The report&apos;s default — anyone reading it can look at another range without changing it.</p>
                  </div>
                ) : (
                  <p className="rounded-lg bg-surface-sunken px-3 py-2 text-[12.5px] text-muted">{open.label} is a snapshot of today: no date range applies.</p>
                )}
                <div>
                  <p className="text-[12.5px] font-medium text-text">Access</p>
                  <div className="mt-1 space-y-1.5">
                    {(
                      [
                        ["none", "Only me", "Share it with people later."],
                        ["view", "My department can view", "Everyone in your department can open it."],
                        ["edit", "My department can edit", "They can change it too."],
                      ] as const
                    ).map(([v, label, hint]) => (
                      <label key={v} className={cn("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2", access === v ? "border-brand bg-brand-subtle/40" : "border-line", v !== "none" && !hasDepartment && "cursor-not-allowed opacity-50")}>
                        <input type="radio" name="access" value={v} checked={access === v} disabled={v !== "none" && !hasDepartment} onChange={() => setAccess(v)} className="mt-0.5 accent-[var(--brand)]" />
                        <span>
                          <span className="block text-[13px] text-text">{label}</span>
                          <span className="block text-[12px] text-subtle">{v !== "none" && !hasDepartment ? "You aren't in a department." : hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-1.5 text-[12px] text-subtle">Whoever opens it sees only the rows their own role allows.</p>
                </div>
              </div>
            )}
          </div>

          {/* The source */}
          {step === 0 && (
            <aside className="border-t border-line bg-surface-sunken/40 p-5 lg:border-l lg:border-t-0">
              {!open ? (
                <p className="text-[13px] text-muted">Pick a source to see what it holds.</p>
              ) : (
                <>
                  <p className="text-[14px] font-semibold text-text">{open.label}</p>
                  <p className="text-[12px] text-subtle">{open.group}</p>
                  <p className="mt-2 text-[13px] text-muted">{open.description}</p>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <div className="rounded-lg bg-surface px-3 py-2">
                      <p className="text-[18px] font-semibold tabular-nums text-text">
                        {preview === "loading" || preview === null ? "…" : "error" in preview ? "—" : `${preview.rows.toLocaleString("en-IN")}${preview.capped ? "+" : ""}`}
                      </p>
                      <p className="text-[11.5px] text-subtle">{open.snapshot ? "rows you can see now" : "rows you can see this FY"}</p>
                    </div>
                    <div className="rounded-lg bg-surface px-3 py-2">
                      <p className="text-[18px] font-semibold tabular-nums text-text">{open.dimensions.length + open.measures.length}</p>
                      <p className="text-[11.5px] text-subtle">fields</p>
                    </div>
                  </div>
                  {preview && preview !== "loading" && "error" in preview && <p className="mt-2 text-[12.5px] text-danger">{preview.error}</p>}
                  <p className="mt-4 text-[12.5px] font-medium text-text">Dimensions</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {open.dimensions.slice(0, 12).map((d) => (
                      <span key={d.key} className="rounded-full bg-success-bg px-2 py-0.5 text-[12px] text-success">
                        {d.label}
                      </span>
                    ))}
                    {open.dimensions.length > 12 && <span className="text-[12px] text-subtle">+{open.dimensions.length - 12} more</span>}
                  </div>
                  <p className="mt-3 text-[12.5px] font-medium text-text">Metrics</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {open.measures.map((m) => (
                      <span key={m.key} className="rounded-full bg-brand-subtle px-2 py-0.5 text-[12px] text-brand">
                        {m.label}
                      </span>
                    ))}
                  </div>
                  <p className="mt-4 text-[12px] text-subtle">Only the fields your role can see are listed.</p>
                </>
              )}
            </aside>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          <p className="mr-auto text-[12.5px] text-subtle">
            {step === 0 ? "Next: start blank or from a template, then name it." : step === 1 ? "Next: name it and choose who can see it." : "The builder opens on your new report."}
          </p>
          {error && (
            <p role="alert" className="w-full text-[13px] text-danger sm:w-auto">
              {error}
            </p>
          )}
          <Link href="/reports" className="inline-flex h-9 items-center rounded-base border border-line-strong px-3.5 text-sm font-medium text-text hover:bg-surface-sunken">
            Cancel
          </Link>
          {step > 0 && (
            <Button type="button" variant="secondary" onClick={() => setStep((step - 1) as 0 | 1)}>
              Back
            </Button>
          )}
          <Button type="button" onClick={next} disabled={!open || creating}>
            {step === 2 ? (creating ? "Creating…" : "Create report") : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
