"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PRESETS,
  type PresetKey,
  computePreset,
  matchPreset,
  toISODate,
  fromISODate,
  formatShortYear,
  addMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  startOfDay,
  addDays,
  isSameDay,
} from "@/lib/date-range-presets";

/**
 * The accessible name of a day cell — "21 September 2026".
 *
 * The visible cell stays the bare number, which is all it needs to be with the month heading above
 * it and the week grid around it. Spoken, "21" is not a date: no month, no year, and nothing to
 * tell the 21st of the left-hand month from the 21st of the right-hand one, which are eleven
 * gridcells apart and sound identical. Day-month-year, and so `en-GB`, because that is the order
 * that reads as a date out loud; the visible month caption stays `en-US` like the rest of the app.
 */
function dayName(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * Month arithmetic that cannot land on a day the target month does not have.
 *
 * `addMonths` is `Date#setMonth`, which rolls 31 March back a month into 3 March. PageUp from the
 * 31st has to land on the 28th; rolling over would skip a whole month and look like the key did
 * something else entirely.
 */
function addMonthsClamped(d: Date, n: number) {
  const target = addMonths(startOfMonth(d), n);
  const lastDay = endOfMonth(target).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay));
}

function MonthGrid({
  month,
  rangeStart,
  rangeEnd,
  previewEnd,
  focusDay,
  onSelectDay,
  onHoverDay,
  onKeyDown,
}: {
  month: Date;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  previewEnd: Date | null;
  /**
   * The single day that holds the tab stop, across *both* months — see the roving-tabindex note in
   * `DateRangePicker`. A cell claims it only when it also belongs to this grid's own month, which
   * is what keeps the count at exactly one when a day is shown twice (30 September is a real cell
   * in September and a filler cell in October).
   */
  focusDay: Date;
  onSelectDay: (d: Date) => void;
  onHoverDay: (d: Date | null) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
}) {
  const firstOfMonth = startOfMonth(month);
  const gridStart = startOfWeek(firstOfMonth);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(gridStart, w * 7 + i)));
  const effectiveEnd = rangeEnd ?? previewEnd;
  const today = startOfDay(new Date());
  const monthName = month.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  return (
    <div>
      <div className="mb-1 text-center text-xs font-medium text-muted">{monthName}</div>
      {/*
        Decorative: the initials repeat (S/T twice each) and say nothing a cell's own name does not
        already carry, so reading them out is seven syllables of noise before every row.
      */}
      <div aria-hidden="true" className="grid grid-cols-7 text-center text-[11px] text-subtle">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="py-1">
            {d}
          </div>
        ))}
      </div>
      {/*
        The `grid grid-cols-7` moved off the container and onto each week, because `role="row"`
        needs a real element to sit on and a row of seven cells is what it has to wrap. Six
        seven-column grids stacked in the same box lay out identically to one 42-cell grid: equal
        `1fr` columns measured against the same width, the same 28px rows, no gaps either way.
      */}
      <div role="grid" aria-label={monthName} onKeyDown={onKeyDown}>
        {weeks.map((week) => (
          <div key={toISODate(week[0])} role="row" className="grid grid-cols-7">
            {week.map((d) => {
              const inMonth = d.getMonth() === firstOfMonth.getMonth();
              const isStart = isSameDay(d, rangeStart);
              const isEnd = isSameDay(d, rangeEnd ?? null);
              const inRange = Boolean(rangeStart && effectiveEnd && d > rangeStart && d < effectiveEnd);
              return (
                <button
                  key={d.toISOString()}
                  type="button"
                  role="gridcell"
                  data-day={toISODate(d)}
                  aria-label={dayName(d)}
                  aria-selected={isStart || isEnd || inRange}
                  aria-current={isSameDay(d, today) ? "date" : undefined}
                  tabIndex={inMonth && isSameDay(d, focusDay) ? 0 : -1}
                  onClick={() => onSelectDay(d)}
                  onMouseEnter={() => onHoverDay(d)}
                  className={cn(
                    "h-7 text-xs",
                    !inMonth && "text-subtle",
                    inRange && "bg-surface-sunken",
                    (isStart || isEnd) && "rounded-full bg-brand font-medium text-white",
                    !isStart && !isEnd && inMonth && "text-text hover:bg-surface-sunken",
                  )}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

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

  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState<Date | null>(urlFrom);
  const [draftTo, setDraftTo] = useState<Date | null>(urlTo);
  const [hoverDay, setHoverDay] = useState<Date | null>(null);
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(addMonths(urlTo ?? new Date(), -1)));
  const [focusedDay, setFocusedDay] = useState<Date | null>(null);

  const gridsRef = useRef<HTMLDivElement>(null);
  /** Set only by `moveFocus`, so a mouse click never yanks focus anywhere. */
  const shouldFocusRef = useRef(false);

  const displayStart = startOfMonth(viewMonth);
  const displayEnd = endOfMonth(addMonths(viewMonth, 1));
  /**
   * The roving tabindex, resolved once per render and shared by both grids.
   *
   * Clamped into the two displayed months rather than trusted, because the month can also move
   * under it — the chevrons, a preset, and the two date inputs all change the view without touching
   * the focused day. Off-view would mean *zero* cells with `tabIndex={0}` and a calendar the Tab
   * key walks straight past, which is the failure this whole change exists to fix, so the fallback
   * is the 1st of the left-hand month rather than nothing.
   */
  const focusDay = focusedDay && focusedDay >= displayStart && focusedDay <= displayEnd ? focusedDay : displayStart;

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  /**
   * Arrow keys move state, and state moves the DOM focus — after the commit, because the cell being
   * moved to may not have existed before it (crossing a month boundary re-renders both grids). The
   * tab stop and the focus target are the same cell by definition, so the selector is just "the one
   * gridcell in the tab order" and never needs to know which month won.
   */
  useEffect(() => {
    if (!shouldFocusRef.current) return;
    shouldFocusRef.current = false;
    gridsRef.current?.querySelector<HTMLButtonElement>('[role="gridcell"][tabindex="0"]')?.focus();
  });

  function openPopover() {
    setDraftFrom(urlFrom);
    setDraftTo(urlTo);
    setSelectingEnd(false);
    setViewMonth(startOfMonth(addMonths(urlTo ?? new Date(), -1)));
    setFocusedDay(urlTo ?? urlFrom ?? startOfDay(new Date()));
    setOpen(true);
  }

  function handlePreset(key: PresetKey) {
    const { from, to } = computePreset(key);
    setDraftFrom(from);
    setDraftTo(to);
    setSelectingEnd(false);
    setViewMonth(startOfMonth(addMonths(to ?? from ?? new Date(), -1)));
    setFocusedDay(to ?? from ?? startOfDay(new Date()));
  }

  function handleSelectDay(d: Date) {
    setFocusedDay(d);
    if (selectingEnd && draftFrom) {
      if (d < draftFrom) {
        setDraftFrom(d);
        setDraftTo(null);
      } else {
        setDraftTo(d);
        setSelectingEnd(false);
      }
    } else {
      setDraftFrom(d);
      setDraftTo(null);
      setSelectingEnd(true);
    }
  }

  /**
   * Move the focused day, pulling the view along with it.
   *
   * Walking off the left edge of the first month or the right edge of the second advances the view
   * by a month instead of dead-ending, so every date is reachable with the arrow keys alone. The
   * day always lands in-month in exactly one of the two grids, which is what keeps the tab stop
   * unique and means the duplicate filler cells are never an arrow-key destination.
   */
  function moveFocus(next: Date) {
    setFocusedDay(next);
    if (next < displayStart) setViewMonth(startOfMonth(next));
    else if (next > displayEnd) setViewMonth(startOfMonth(addMonths(startOfMonth(next), -1)));
    shouldFocusRef.current = true;
  }

  /**
   * Enter and Space are deliberately absent: the cells are real `<button>`s, so the browser already
   * turns both into a click on the focused one, and handling them here as well would either pick
   * the day twice — advancing start-then-end in a single keystroke — or depend on `preventDefault`
   * suppressing an activation that fires on `keyup` for Space and `keydown` for Enter.
   */
  function handleGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    /**
     * Bare keys only.
     *
     * The switch below matches on `e.key` and then calls `preventDefault()` unconditionally, so a
     * modified press was treated as a plain one: Ctrl+ArrowLeft, Alt+ArrowLeft (back, on Windows),
     * Shift+Home and the OS shortcuts built on them all moved the calendar by a day and were
     * swallowed on the way. Nothing here wants a modifier, so nothing here should claim one.
     */
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;

    let next: Date;
    switch (e.key) {
      case "ArrowLeft":
        next = addDays(focusDay, -1);
        break;
      case "ArrowRight":
        next = addDays(focusDay, 1);
        break;
      case "ArrowUp":
        next = addDays(focusDay, -7);
        break;
      case "ArrowDown":
        next = addDays(focusDay, 7);
        break;
      case "Home":
        next = startOfWeek(focusDay);
        break;
      case "End":
        next = addDays(startOfWeek(focusDay), 6);
        break;
      case "PageUp":
        next = addMonthsClamped(focusDay, -1);
        break;
      case "PageDown":
        next = addMonthsClamped(focusDay, 1);
        break;
      default:
        return;
    }
    e.preventDefault();
    moveFocus(next);
  }

  function handleApply() {
    const params = new URLSearchParams(searchParams.toString());
    if (draftFrom) params.set(fromParam, toISODate(draftFrom));
    else params.delete(fromParam);
    if (draftTo) params.set(toParam, toISODate(draftTo));
    else params.delete(toParam);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
    setOpen(false);
  }

  const activePreset = matchPreset(urlFrom, urlTo);
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
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => (open ? setOpen(false) : openPopover())}
        className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-text hover:border-line-strong"
      >
        <span id={valueId}>{displayText}</span>
        <ChevronDown className="h-3.5 w-3.5 text-subtle" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label={`${label} date range`}
            className="absolute left-0 top-full z-40 mt-1 flex rounded-md border border-line bg-surface shadow-lg"
          >
            <div className="w-40 shrink-0 border-r border-line py-2">
              {PRESETS.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  aria-current={matchPreset(draftFrom, draftTo) === p.key ? "true" : undefined}
                  onClick={() => handlePreset(p.key)}
                  className={cn(
                    "block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-sunken",
                    matchPreset(draftFrom, draftTo) === p.key
                      ? "bg-surface-sunken font-medium text-text"
                      : "text-muted",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="w-[420px] p-3" onMouseLeave={() => setHoverDay(null)}>
              <div className="mb-2 flex items-center gap-2">
                <input
                  type="date"
                  aria-label={`${label} range start`}
                  value={draftFrom ? toISODate(draftFrom) : ""}
                  onChange={(e) => setDraftFrom(fromISODate(e.target.value))}
                  className="h-8 w-36 rounded-md border border-line-strong px-2 text-xs"
                />
                <span className="text-subtle">–</span>
                <input
                  type="date"
                  aria-label={`${label} range end`}
                  value={draftTo ? toISODate(draftTo) : ""}
                  onChange={(e) => setDraftTo(fromISODate(e.target.value))}
                  className="h-8 w-36 rounded-md border border-line-strong px-2 text-xs"
                />
              </div>

              <div className="mb-1 flex items-center justify-between">
                <button
                  type="button"
                  aria-label="Previous month"
                  onClick={() => setViewMonth((m) => addMonths(m, -1))}
                  className="rounded p-1 text-muted hover:bg-surface-sunken"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  aria-label="Next month"
                  onClick={() => setViewMonth((m) => addMonths(m, 1))}
                  className="rounded p-1 text-muted hover:bg-surface-sunken"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              <div ref={gridsRef} className="flex gap-4">
                <MonthGrid
                  month={viewMonth}
                  rangeStart={draftFrom}
                  rangeEnd={draftTo}
                  previewEnd={selectingEnd ? hoverDay : null}
                  focusDay={focusDay}
                  onSelectDay={handleSelectDay}
                  onHoverDay={setHoverDay}
                  onKeyDown={handleGridKeyDown}
                />
                <MonthGrid
                  month={addMonths(viewMonth, 1)}
                  rangeStart={draftFrom}
                  rangeEnd={draftTo}
                  previewEnd={selectingEnd ? hoverDay : null}
                  focusDay={focusDay}
                  onSelectDay={handleSelectDay}
                  onHoverDay={setHoverDay}
                  onKeyDown={handleGridKeyDown}
                />
              </div>

              <div className="mt-3 flex justify-end gap-2 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-1.5 text-sm text-muted hover:bg-surface-sunken"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-brand"
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
