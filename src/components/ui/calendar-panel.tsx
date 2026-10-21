"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { LAYER_POPOVER } from "@/components/ui/layers";
import { addDays, addMonths, endOfMonth, isSameDay, startOfMonth } from "@/lib/date-range-presets";
import { cn } from "@/lib/utils";

/**
 * The date picker every calendar in the app opens (owner, 19 Oct 2026, from a reference image): quick
 * choices down the left; the month with its name to change it and arrows either side; a Monday-first
 * grid where the chosen start and end are navy, the days between sit on a light band and today is
 * ringed; the dates typed as DD/MM/YYYY below; and "Clear dates" and Done along the foot.
 *
 * One panel for every use — a filter's range (src/components/ui/date-range-picker.tsx), and every
 * date, date-and-time and month field (src/components/ui/date-field.tsx). It holds no value of its
 * own: it shows what it is given and says what was picked, and its owner decides when that counts.
 *
 * Days are held as `Date`s at local midnight, as src/lib/date-range-presets.ts holds them; "today"
 * comes from the owner, on the workspace's clock.
 */

export type CalendarPreset = { key: string; label: string; from: Date | null; to: Date | null };

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The Monday on or before a day — the grid's weeks start on Monday, as the reference does. */
export function startOfWeekMonday(d: Date) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/** "08/10/2026". */
export function formatDMY(d: Date) {
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

/**
 * A typed DD/MM/YYYY — slashes, dashes or dots between, a two-digit year read as this century — or
 * null when it isn't a real day ("31/02/2026").
 */
export function parseDMY(text: string): Date | null {
  const m = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\s*$/.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]) - 1;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(year, month, day);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

/**
 * What is typed, shaped as DD/MM/YYYY as it goes: "08102026" becomes "08/10/2026", and "8/10/2026"
 * "08/10/2026" — a slash typed after one digit pads it. The next slash is put in only while typing
 * forwards, so backspace can take it out again.
 */
function maskDMY(raw: string, growing: boolean) {
  const parts = [""];
  for (const ch of raw) {
    const i = parts.length - 1;
    if (/\d/.test(ch)) {
      if (i < 2 && parts[i]!.length === 2) parts.push(ch);
      else if (i < 2 || parts[i]!.length < 4) parts[i] += ch;
    } else if (/[/.\-]/.test(ch) && i < 2 && parts[i] !== "") {
      parts[i] = parts[i]!.padStart(2, "0");
      parts.push("");
    }
  }
  const last = parts.length - 1;
  return parts.join("/") + (growing && last < 2 && parts[last]!.length === 2 ? "/" : "");
}

/** The accessible name of a day — "8 October 2026" — where the cell itself shows only "8". */
function dayName(d: Date) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** A month back or forward without falling off its end: PageUp from 31 March lands on 28 February. */
function addMonthsClamped(d: Date, n: number) {
  const target = addMonths(startOfMonth(d), n);
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), endOfMonth(target).getDate()));
}

const within = (d: Date, min: Date | null, max: Date | null) => (!min || d >= min) && (!max || d <= max);

export type CalendarPlacement = { sheet: boolean; width: number; align: "start" | "end" };

/**
 * Where a calendar opening now from `anchor` goes — worked out as it opens, in the browser: under (or
 * over) the anchor, as wide as `width` and right-aligned with it when there's no room to its right; or
 * on a phone, where it fits neither above nor below a field, as a sheet across the foot of the screen.
 */
export function placeCalendar(anchor: HTMLElement | null, width: number): CalendarPlacement {
  const fits = Math.min(width, window.innerWidth - 16);
  const left = anchor?.getBoundingClientRect().left ?? 0;
  return { sheet: window.matchMedia("(max-width: 639px)").matches, width: fits, align: left + fits > window.innerWidth - 8 ? "end" : "start" };
}

/**
 * An open calendar, where `placeCalendar` put it. Either way it is an `[data-anchored-popover]`, which
 * is what every outside-click check in the app — `useCalendarDismiss` here among them — leaves alone.
 */
export function CalendarPopover({
  anchorRef,
  placement,
  fitHeight,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Null while closed. */
  placement: CalendarPlacement | null;
  /** The height it needs to show whole, so it opens above the field rather than scrolled. */
  fitHeight: number;
  children: ReactNode;
}) {
  if (!placement) return null;
  if (placement.sheet) {
    return createPortal(
      <div className={cn(LAYER_POPOVER, "fixed inset-0 flex items-end bg-black/40")}>
        <div
          data-anchored-popover=""
          className="max-h-[92dvh] w-full overflow-y-auto overscroll-contain rounded-t-2xl border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-xl"
        >
          {children}
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <AnchoredPopover
      anchorRef={anchorRef}
      open
      width={placement.width}
      align={placement.align}
      maxHeight={640}
      fitHeight={fitHeight}
      className="rounded-2xl border-line shadow-xl"
    >
      {children}
    </AnchoredPopover>
  );
}

/**
 * How an open calendar closes, the same wherever it opens: on Escape — heard before a dialog around it
 * hears it and closes as well — and on a press or the focus landing anywhere but the field and the
 * panel. And while the focus is in the panel, Tab goes round the panel: it is drawn at the end of the
 * page, so the next thing after it would be whatever the page ends with.
 */
export function useCalendarDismiss(
  open: boolean,
  trigger: RefObject<HTMLElement | null>,
  /** Anything inside the panel; the panel is the AnchoredPopover holding it. */
  inside: RefObject<HTMLElement | null>,
  onDismiss: (how: "escape" | "elsewhere") => void,
) {
  const dismiss = useRef(onDismiss);
  useEffect(() => {
    dismiss.current = onDismiss;
  });

  useEffect(() => {
    if (!open) return;
    const panel = () => inside.current?.closest<HTMLElement>("[data-anchored-popover]") ?? null;
    const ours = (t: EventTarget | null) => t instanceof Node && (!!trigger.current?.contains(t) || !!panel()?.contains(t));
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        dismiss.current("escape");
        return;
      }
      const root = panel();
      if (e.key !== "Tab" || !root?.contains(document.activeElement)) return;
      const stops = Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")).filter((el) => el.tabIndex >= 0);
      if (stops.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const at = stops.indexOf(document.activeElement as HTMLElement);
      stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]!.focus();
    }
    function onPointerDown(e: PointerEvent) {
      if (!ours(e.target)) dismiss.current("elsewhere");
    }
    function onFocusIn(e: FocusEvent) {
      if (!ours(e.target)) dismiss.current("elsewhere");
    }
    // Capturing, so a dialog's own Escape and Tab handling never sees a key the calendar took.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, trigger, inside]);
}

export function CalendarPanel({
  mode,
  from,
  to = null,
  onPick,
  presets = [],
  activePreset = null,
  onPreset,
  min = null,
  max = null,
  today,
  fieldLabels,
  clearLabel,
  onClear,
  onDone,
  focusOnMount = false,
  children,
}: {
  /** One day, or a start and an end. */
  mode: "single" | "range";
  from: Date | null;
  /** The end of a range. */
  to?: Date | null;
  /**
   * A day picked on the grid or typed below: the new start and end (a single day is `from`), and which —
   * a field closes on a click, and stays open while a date is being typed.
   */
  onPick: (from: Date | null, to: Date | null, how: "grid" | "typed") => void;
  presets?: CalendarPreset[];
  activePreset?: string | null;
  onPreset?: (preset: CalendarPreset) => void;
  /** The first and last days that may be picked; the rest are shown, and can't be. */
  min?: Date | null;
  max?: Date | null;
  /** On the workspace's clock. */
  today: Date;
  /** Above the typed dates: "Start date" and "End date", or "Date". */
  fieldLabels: [string] | [string, string];
  clearLabel: string;
  onClear: () => void;
  onDone: () => void;
  /** Opened from the keyboard: the focus goes to the chosen day (or today), so the arrows work at once. */
  focusOnMount?: boolean;
  /** Anything more a field needs under the dates — the time, for a date and time. */
  children?: ReactNode;
}) {
  const [view, setView] = useState(() => startOfMonth(to ?? from ?? today));
  const [choosingMonth, setChoosingMonth] = useState(false);
  /** In a range, after the start is picked and before the end is. */
  const [selectingEnd, setSelectingEnd] = useState(false);
  const [hover, setHover] = useState<Date | null>(null);
  const [focused, setFocused] = useState<Date | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const shouldFocus = useRef(focusOnMount);

  const firstOfView = startOfMonth(view);
  const gridStart = startOfWeekMonday(firstOfView);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(gridStart, w * 7 + i)));
  // The roving tab stop: the focused day while it is in this month; otherwise the chosen day, today
  // or the 1st — never nothing, or Tab would walk straight past the grid.
  const inView = (d: Date | null) => !!d && d.getFullYear() === view.getFullYear() && d.getMonth() === view.getMonth();
  const focusDay = [focused, from, today].find((d) => inView(d)) ?? firstOfView;

  useEffect(() => {
    if (!shouldFocus.current) return;
    shouldFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('[role="gridcell"][tabindex="0"]')?.focus();
  });

  const show = (d: Date | null) => {
    if (d) setView(startOfMonth(d));
  };

  function pickDay(d: Date) {
    setFocused(d);
    if (mode === "single") {
      onPick(d, null, "grid");
      return;
    }
    if (selectingEnd && from && d >= from) {
      onPick(from, d, "grid");
      setSelectingEnd(false);
    } else {
      onPick(d, null, "grid");
      setSelectingEnd(true);
    }
  }

  function moveFocus(next: Date) {
    setFocused(next);
    setView(startOfMonth(next));
    shouldFocus.current = true;
  }

  function onGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const steps: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focusDay, -1),
      ArrowRight: () => addDays(focusDay, 1),
      ArrowUp: () => addDays(focusDay, -7),
      ArrowDown: () => addDays(focusDay, 7),
      Home: () => startOfWeekMonday(focusDay),
      End: () => addDays(startOfWeekMonday(focusDay), 6),
      PageUp: () => addMonthsClamped(focusDay, -1),
      PageDown: () => addMonthsClamped(focusDay, 1),
    };
    const step = steps[e.key];
    if (!step) return;
    e.preventDefault();
    moveFocus(step());
  }

  // The end the band reaches to: the chosen one, or the day under the pointer while choosing it.
  const bandEnd = mode === "range" ? (to ?? (selectingEnd && hover && from && hover > from ? hover : null)) : null;
  const banded = mode === "range" && !!from && !!bandEnd && bandEnd > from;

  return (
    // A container, so the quick choices go down the side when the panel is wide enough and across the
    // top on a phone — by the panel's own width, which a dialog's narrowness decides, not the window's.
    <div className="@container flex flex-col text-text">
      <div className="flex flex-col @md:flex-row">
        {presets.length > 0 && (
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 @md:w-[9.5rem] @md:flex-col @md:gap-0.5 @md:overflow-visible @md:border-b-0 @md:border-r @md:py-4">
            {presets.map((p) => {
              const usable = (!p.from || within(p.from, min, max)) && (!p.to || within(p.to, min, max));
              return (
                <button
                  key={p.key}
                  type="button"
                  disabled={!usable}
                  aria-current={activePreset === p.key ? "true" : undefined}
                  onClick={() => {
                    onPreset?.(p);
                    setSelectingEnd(false);
                    show(p.to ?? p.from);
                  }}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                    activePreset === p.key ? "bg-calendar-range font-medium text-text" : "text-text hover:bg-surface-sunken",
                  )}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="mx-auto w-[19.5rem] max-w-full px-4 pb-4 pt-3.5 @md:mx-0" onMouseLeave={() => setHover(null)}>
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              aria-expanded={choosingMonth}
              onClick={() => setChoosingMonth((c) => !c)}
              className="-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[15px] font-semibold hover:bg-surface-sunken"
            >
              {choosingMonth ? view.getFullYear() : `${MONTHS[view.getMonth()]} ${view.getFullYear()}`}
              <ChevronDown className={cn("h-4 w-4 text-muted transition-transform", choosingMonth && "rotate-180")} aria-hidden />
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label={choosingMonth ? "Previous year" : "Previous month"}
                onClick={() => setView((v) => addMonths(v, choosingMonth ? -12 : -1))}
                className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={choosingMonth ? "Next year" : "Next month"}
                onClick={() => setView((v) => addMonths(v, choosingMonth ? 12 : 1))}
                className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
              >
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>

          {choosingMonth ? (
            <div className="grid grid-cols-3 gap-1.5 py-2" role="group" aria-label={`Months of ${view.getFullYear()}`}>
              {MONTHS.map((name, i) => {
                const first = new Date(view.getFullYear(), i, 1);
                const usable = (!max || first <= max) && (!min || endOfMonth(first) >= min);
                const current = i === view.getMonth();
                return (
                  <button
                    key={name}
                    type="button"
                    disabled={!usable}
                    aria-label={`${name} ${view.getFullYear()}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      setView(first);
                      setChoosingMonth(false);
                    }}
                    className={cn(
                      "h-10 rounded-lg text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                      current ? "bg-calendar-selected font-semibold text-calendar-selected-contrast" : "hover:bg-surface-sunken",
                    )}
                  >
                    {name.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {/* Decorative: each day's own name already says which day of the week it is. */}
              <div aria-hidden className="grid grid-cols-7 pb-1 text-center text-[11px] font-semibold tracking-wide text-muted">
                {WEEKDAYS.map((d) => (
                  <div key={d}>{d}</div>
                ))}
              </div>
              <div ref={gridRef} role="grid" aria-label={`${MONTHS[view.getMonth()]} ${view.getFullYear()}`} onKeyDown={onGridKeyDown}>
                {weeks.map((week) => (
                  <div key={week[0]!.toDateString()} role="row" className="grid grid-cols-7">
                    {week.map((d, i) => {
                      const inMonth = d.getMonth() === firstOfView.getMonth();
                      const isFrom = isSameDay(d, from);
                      const isTo = mode === "range" && isSameDay(d, bandEnd);
                      const between = banded && d > from! && d < bandEnd!;
                      const chosen = isFrom || (mode === "range" && isSameDay(d, to));
                      const usable = within(d, min, max);
                      return (
                        <div key={d.toDateString()} className="relative flex h-10 items-center justify-center">
                          {/* The band: whole for the days between, half for the start and the end, rounded where a row ends. */}
                          {between && <span aria-hidden className={cn("absolute inset-x-0 inset-y-0.5 bg-calendar-range", i === 0 && "rounded-l-full", i === 6 && "rounded-r-full")} />}
                          {banded && isFrom && i !== 6 && <span aria-hidden className="absolute inset-y-0.5 left-1/2 right-0 bg-calendar-range" />}
                          {banded && isTo && !isFrom && i !== 0 && <span aria-hidden className="absolute inset-y-0.5 left-0 right-1/2 bg-calendar-range" />}
                          <button
                            type="button"
                            role="gridcell"
                            data-day={`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`}
                            aria-label={dayName(d)}
                            aria-selected={chosen || between}
                            aria-current={isSameDay(d, today) ? "date" : undefined}
                            disabled={!usable}
                            tabIndex={isSameDay(d, focusDay) ? 0 : -1}
                            onClick={() => pickDay(d)}
                            onMouseEnter={() => setHover(d)}
                            className={cn(
                              "relative grid h-9 w-9 place-items-center rounded-full text-[15px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                              chosen || isTo
                                ? "bg-calendar-selected font-semibold text-calendar-selected-contrast"
                                : cn(
                                    isSameDay(d, today) && "border border-calendar-today bg-surface font-semibold text-calendar-selected",
                                    !inMonth && "text-subtle",
                                    usable && "hover:bg-surface-sunken",
                                  ),
                            )}
                          >
                            {d.getDate()}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          <div className={cn("mt-3 grid gap-3", fieldLabels.length === 2 ? "grid-cols-2" : "grid-cols-1")}>
            <TypedDate
              label={fieldLabels[0]}
              value={from}
              min={min}
              max={mode === "range" && to ? to : max}
              onCommit={(d) => {
                if (mode === "single") onPick(d, null, "typed");
                else onPick(d, to && d && to < d ? null : to, "typed");
                setSelectingEnd(false);
                show(d);
              }}
            />
            {fieldLabels.length === 2 && (
              <TypedDate
                label={fieldLabels[1]}
                value={to}
                min={from ?? min}
                max={max}
                onCommit={(d) => {
                  onPick(from, d, "typed");
                  setSelectingEnd(false);
                  show(d);
                }}
              />
            )}
          </div>
          {children}
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <button
          type="button"
          onClick={() => {
            setSelectingEnd(false);
            onClear();
          }}
          className="rounded-md px-1 py-1 text-sm text-muted transition-colors hover:text-text"
        >
          {clearLabel}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-calendar-done px-3.5 text-sm font-semibold text-calendar-done-contrast shadow-sm transition-[filter] hover:brightness-110"
        >
          <Check className="h-4 w-4" aria-hidden />
          Done
        </button>
      </div>
    </div>
  );
}

/**
 * One typed date — DD/MM/YYYY, the slashes put in as it is typed, × to empty it. It counts the moment it
 * is a whole, real day inside the range allowed — not on leaving the box, because a click on Done keeps
 * the focus where it is and the box is never left. Until then it keeps what was typed, and on leaving
 * it says it isn't a date.
 */
function TypedDate({
  label,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  value: Date | null;
  min: Date | null;
  max: Date | null;
  onCommit: (d: Date | null) => void;
}) {
  const shown = value ? formatDMY(value) : "";
  const [text, setText] = useState(shown);
  const [synced, setSynced] = useState(shown);
  const [bad, setBad] = useState(false);
  // A date chosen on the grid (or a preset) replaces whatever was being typed.
  if (synced !== shown) {
    setSynced(shown);
    setText(shown);
    setBad(false);
  }

  /** `final` on Enter or leaving the box: a part-typed date is then called out, rather than waited for. */
  function commit(typed: string, final: boolean) {
    if (typed.trim() === "") {
      setBad(false);
      if (value) onCommit(null);
      return;
    }
    const d = typed.length >= 8 ? parseDMY(typed) : null;
    if (!d || !within(d, min, max)) {
      setBad(final || typed.length === 10);
      return;
    }
    setBad(false);
    if (!value || !isSameDay(d, value)) onCommit(d);
    else if (final) setText(formatDMY(d));
  }

  return (
    <label className="block space-y-1">
      <span className="block text-xs text-muted">{label}</span>
      <span
        className={cn(
          "flex h-10 items-center rounded-xl border bg-surface pl-3 pr-1.5 transition-colors focus-within:border-brand",
          bad ? "border-danger" : "border-line-strong",
        )}
      >
        <input
          value={text}
          inputMode="numeric"
          placeholder="DD/MM/YYYY"
          maxLength={10}
          aria-invalid={bad || undefined}
          onChange={(e) => {
            const typed = maskDMY(e.target.value, e.target.value.length > text.length);
            setText(typed);
            setBad(false);
            if (typed === "" || typed.length === 10) commit(typed, false);
          }}
          onBlur={() => commit(text, true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(text, true);
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-[15px] tabular-nums text-text outline-none placeholder:text-subtle"
        />
        {text && (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            onClick={() => {
              setText("");
              setBad(false);
              onCommit(null);
            }}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-sunken hover:text-text"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </span>
      {bad && <span className="block text-[11px] text-danger">Not a date{min || max ? " that can be chosen here" : ""}.</span>}
    </label>
  );
}
