"use client";

import { useId, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { useClock } from "@/components/time/clock-provider";
import {
  CalendarPanel,
  CalendarPopover,
  placeCalendar,
  useCalendarDismiss,
  type CalendarPlacement,
  type CalendarPreset,
} from "@/components/ui/calendar-panel";
import {
  PRESETS,
  type PresetKey,
  computePreset,
  todayOn,
  matchPreset,
  toISODate,
  fromISODate,
  formatShortYear,
} from "@/lib/date-range-presets";

/** The quick ranges down the side of the calendar, in the owner's order (19 Oct 2026, from the reference). */
const RANGE_PRESETS: PresetKey[] = ["today", "yesterday", "last7", "last30", "thisMonth", "lastMonth"];

/**
 * A list's date filter: the label, and a button reading "All time", the preset it matches or the dates,
 * that opens the app's calendar (src/components/ui/calendar-panel.tsx). The range lives in the URL —
 * `fromParam` and `toParam` as `yyyy-mm-dd` — so the view survives a reload and can be sent as a link;
 * the calendar changes a draft of it, and Done puts the draft in the URL. Escape or a click elsewhere
 * leaves the URL as it was.
 */
export function DateRangePicker({
  fromParam,
  toParam,
  label,
  resetParams = ["page"],
}: {
  fromParam: string;
  toParam: string;
  label: string;
  /**
   * The page numbers this filter invalidates — the same prop its sibling filters take, and the one
   * it was missing. Narrowing a list while standing on page 3 left the page number behind and
   * showed an empty page 3 of a one-page result, which reads as "no matches" on a dozen screens.
   */
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clock = useClock();
  const urlFrom = fromISODate(searchParams.get(fromParam) ?? "");
  const urlTo = fromISODate(searchParams.get(toParam) ?? "");

  /**
   * `useId` and not a literal: this filter is rendered several times on one screen (created-on and
   * closed-on, side by side), and a hardcoded id would be a duplicate the moment the second one
   * mounts — which points every `aria-labelledby` at whichever copy the browser found first.
   */
  const uid = useId();
  const labelId = `${uid}-label`;
  const valueId = `${uid}-value`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Open: where, and whether from the keyboard — the calendar then takes the focus. */
  const [open, setOpen] = useState<false | (CalendarPlacement & { keyboard: boolean })>(false);
  const [draftFrom, setDraftFrom] = useState<Date | null>(urlFrom);
  const [draftTo, setDraftTo] = useState<Date | null>(urlTo);

  useCalendarDismiss(!!open, triggerRef, panelRef, (how) => {
    setOpen(false);
    if (how === "escape") triggerRef.current?.focus();
  });

  function openPopover(keyboard: boolean) {
    setDraftFrom(urlFrom);
    setDraftTo(urlTo);
    setOpen({ ...placeCalendar(triggerRef.current, 466), keyboard });
  }

  function handleDone() {
    const params = new URLSearchParams(searchParams.toString());
    if (draftFrom) params.set(fromParam, toISODate(draftFrom));
    else params.delete(fromParam);
    if (draftTo) params.set(toParam, toISODate(draftTo));
    else params.delete(toParam);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
    setOpen(false);
    triggerRef.current?.focus();
  }

  const presets: CalendarPreset[] = RANGE_PRESETS.map((key) => ({
    key,
    label: PRESETS.find((p) => p.key === key)!.label,
    ...computePreset(key, clock),
  }));

  const activePreset = matchPreset(urlFrom, urlTo, clock);
  const displayText =
    !urlFrom && !urlTo
      ? "All time"
      : (PRESETS.find((p) => p.key === activePreset)?.label ??
        `${urlFrom ? formatShortYear(urlFrom) : "…"} – ${urlTo ? formatShortYear(urlTo) : "…"}`);

  return (
    <div className="relative flex items-center gap-2 text-sm">
      {/*
        Was a label element with no `htmlFor`, which is a caption: it looks like a label and names
        nothing. The trigger borrows it by id instead, so the button announces "Created, Last 7
        days" rather than a bare "Last 7 days" with no clue which filter on the row it belongs to.
      */}
      <span id={labelId} className="text-muted">
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={!!open}
        aria-labelledby={`${labelId} ${valueId}`}
        // `detail` is 0 for a click made by Enter or Space: the calendar then takes the focus.
        onClick={(e) => (open ? setOpen(false) : openPopover(e.detail === 0))}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-text hover:border-line-strong"
      >
        <span id={valueId}>{displayText}</span>
        <ChevronDown className="h-3.5 w-3.5 text-subtle" />
      </button>

      <CalendarPopover anchorRef={triggerRef} placement={open || null} fitHeight={470}>
        <div ref={panelRef} role="dialog" aria-label={`${label} date range`}>
          <CalendarPanel
            mode="range"
            from={draftFrom}
            to={draftTo}
            onPick={(from, to) => {
              setDraftFrom(from);
              setDraftTo(to);
            }}
            presets={presets}
            activePreset={matchPreset(draftFrom, draftTo, clock)}
            onPreset={(p) => {
              setDraftFrom(p.from);
              setDraftTo(p.to);
            }}
            today={todayOn(clock)}
            fieldLabels={["Start date", "End date"]}
            clearLabel="Clear dates"
            onClear={() => {
              setDraftFrom(null);
              setDraftTo(null);
            }}
            onDone={handleDone}
            focusOnMount={!!open && open.keyboard}
          />
        </div>
      </CalendarPopover>
    </div>
  );
}
