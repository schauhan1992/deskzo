"use client";

import { useEffect, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, X } from "lucide-react";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { DATE_PRESET_LABELS, DATE_PRESETS, type DateRange } from "@/lib/reporting/definition";
import { rangeDays } from "@/lib/reporting/window";
import type { FieldType } from "@/lib/reporting/sources";

/** The little type mark before a field: Date, Aa, ₹, #, fx — as the builder's data panel shows them. */
export function FieldMark({ type, calc }: { type: FieldType | "calc"; calc?: boolean }) {
  const text = calc || type === "calc" ? "fx" : type === "date" ? "Date" : type === "text" ? "Aa" : type === "currency" ? "₹" : "#";
  const tone = calc || type === "calc" ? "bg-info-bg text-info" : type === "date" || type === "text" ? "bg-success-bg text-success" : "bg-brand-subtle text-brand";
  return <span className={cn("inline-grid h-[18px] min-w-[26px] shrink-0 place-items-center rounded px-1 font-mono text-[10px] font-semibold", tone)}>{text}</span>;
}

/**
 * A report's date range: the presets, or two days. The label carries the days it means today, so "This financial
 * year" is never ambiguous about which one.
 */
export function DateRangeMenu({
  value,
  today,
  onChange,
  disabled,
  align = "end",
  extra,
  compact,
}: {
  value: DateRange;
  today: string;
  onChange: (r: DateRange) => void;
  disabled?: boolean;
  align?: "start" | "end";
  /** An entry above the presets — a chart's "Report default". */
  extra?: { label: string; active: boolean; onPick: () => void };
  compact?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(value.from ?? "");
  const [to, setTo] = useState(value.to ?? "");
  const [custom, setCustom] = useState(false);
  const days = rangeDays(value, today);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (anchor.current?.contains(e.target as Node) || insideAnchoredPopover(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCustom(value.preset === "custom");
          setFrom(value.from ?? days.from);
          setTo(value.to ?? days.to);
        }}
        className="inline-flex h-9 max-w-full items-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] text-text hover:bg-surface-sunken disabled:opacity-50"
      >
        <CalendarDays className="h-4 w-4 shrink-0 text-subtle" />
        <span className="truncate font-medium">{extra?.active ? extra.label : DATE_PRESET_LABELS[value.preset]}</span>
        {!compact && !extra?.active && <span className="hidden truncate text-muted sm:inline">{days.label}</span>}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </button>
      <AnchoredPopover anchorRef={anchor} open={open} width={280} maxHeight={460} align={align}>
        <div className="p-1.5" role="dialog" aria-label="Date range">
          {extra && (
            <PresetRow
              label={extra.label}
              active={extra.active}
              onClick={() => {
                extra.onPick();
                setOpen(false);
              }}
            />
          )}
          {DATE_PRESETS.filter((p) => p !== "custom").map((p) => (
            <PresetRow
              key={p}
              label={DATE_PRESET_LABELS[p]}
              hint={rangeDays({ preset: p }, today).label}
              active={!extra?.active && value.preset === p}
              onClick={() => {
                onChange({ preset: p });
                setOpen(false);
              }}
            />
          ))}
          <PresetRow label="Custom range" active={!extra?.active && value.preset === "custom"} onClick={() => setCustom(true)} />
          {custom && (
            <div className="mt-1 space-y-2 border-t border-line px-1.5 pb-1 pt-2">
              <div className="grid grid-cols-2 gap-2">
                <label className="text-[11.5px] text-muted">
                  From
                  <Input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
                </label>
                <label className="text-[11.5px] text-muted">
                  To
                  <Input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
                </label>
              </div>
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={!from || !to || from > to}
                onClick={() => {
                  onChange({ preset: "custom", from, to });
                  setOpen(false);
                }}
              >
                Apply range
              </Button>
            </div>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

function PresetRow({ label, hint, active, onClick }: { label: string; hint?: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px]", active ? "bg-brand-subtle text-brand" : "text-text hover:bg-surface-sunken")}>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11.5px] text-subtle">{hint}</span>}
      {active && <Check className="h-3.5 w-3.5" />}
    </button>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────

export type ToastState = { text: string; failed?: boolean; action?: { label: string; run: () => void } } | null;

export function useToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function show(text: string, opts: { failed?: boolean; action?: { label: string; run: () => void } } = {}) {
    if (timer.current) clearTimeout(timer.current);
    setToast({ text, ...opts });
    timer.current = setTimeout(() => setToast(null), opts.failed ? 7000 : 4000);
  }
  return { toast, show, clear: () => setToast(null) };
}

export function Toast({ toast, onClose }: { toast: ToastState; onClose: () => void }) {
  if (!toast) return null;
  return (
    <div role="status" aria-live="polite" className="fixed bottom-5 left-1/2 z-50 flex max-w-[92vw] -translate-x-1/2 items-center gap-2.5 rounded-xl bg-[var(--text)] px-4 py-2.5 text-[13px] text-[var(--bg)] shadow-lg">
      {toast.failed ? <X className="h-[15px] w-[15px] shrink-0 text-danger" /> : <Check className="h-[15px] w-[15px] shrink-0 text-success" />}
      <span>{toast.text}</span>
      {toast.action && (
        <button type="button" onClick={toast.action.run} className="font-medium text-[color-mix(in_srgb,var(--brand)_45%,var(--bg))] hover:underline">
          {toast.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={onClose} className="ml-1 opacity-60 hover:opacity-100">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** A CSV the server made, saved by the browser. A byte-order mark so Excel reads ₹ and names right. */
export function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
