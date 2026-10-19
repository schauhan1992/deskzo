"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { CalendarDays, Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useClock } from "@/components/time/clock-provider";
import {
  CalendarPanel,
  CalendarPopover,
  formatDMY,
  placeCalendar,
  useCalendarDismiss,
  type CalendarPlacement,
  type CalendarPreset,
} from "@/components/ui/calendar-panel";
import { addDays, endOfMonth, fromISODate, todayOn, toISODate } from "@/lib/date-range-presets";
import { cn } from "@/lib/utils";

/**
 * Every date, date-and-time and month field in the app (`<Input type="date">` and its kin come here —
 * src/components/ui/input.tsx), drawn as the owner's calendar (src/components/ui/calendar-panel.tsx)
 * rather than the browser's own picker, which looked different in every browser and nothing like the
 * rest of the app.
 *
 * The field the form knows is still a real `<input type="date">` (or datetime-local, or month), only
 * out of sight: it carries the name, the value as `yyyy-mm-dd`, `min`, `max` and `required`, and the
 * ref — so a form posts it, react-hook-form registers it, and a controlled `value`/`onChange` works,
 * exactly as before. What shows is a button that reads the date as DD/MM/YYYY and opens the calendar.
 * A day picked there is written into that input as typing would be, so its `onChange` hears it.
 */

type Kind = "date" | "datetime-local" | "month";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The input's own value setter, past React's: writing through it is what makes React see a change. */
function writeValue(el: HTMLInputElement, next: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, next);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Told whenever code sets the input's value — react-hook-form's `reset` and `setValue` do, and nothing
 * re-renders the field when they do. Wraps whatever setter the input already has (React's own, which
 * keeps its change tracking), once per input.
 */
const watchers = new WeakMap<HTMLInputElement, (value: string) => void>();
function watchValue(el: HTMLInputElement, onSet: (value: string) => void) {
  const watched = watchers.has(el);
  watchers.set(el, onSet);
  if (watched) return;
  const own = Object.getOwnPropertyDescriptor(el, "value") ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  Object.defineProperty(el, "value", {
    configurable: true,
    enumerable: own.enumerable,
    get() {
      return own.get!.call(this);
    },
    set(next: string) {
      own.set!.call(this, next);
      queueMicrotask(() => watchers.get(el)?.(own.get!.call(el)));
    },
  });
}

/** "2026-10" as the 1st of that month. */
function fromISOMonth(s: string | undefined) {
  const m = /^(\d{4})-(\d{2})/.exec(s ?? "");
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : null;
}

/** "14:30" as "2:30 pm", as times read across the app (src/lib/time/zone.ts). */
function clockWords(time: string) {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** What the field reads as — "19/10/2026", "19/10/2026, 9:00 am", "October 2026" — or "" when empty. */
function shown(type: Kind, value: string) {
  if (type === "month") {
    const d = fromISOMonth(value);
    return d ? `${MONTHS[d.getMonth()]} ${d.getFullYear()}` : "";
  }
  const day = fromISODate(value.slice(0, 10));
  if (!day) return "";
  const time = type === "datetime-local" ? value.slice(11, 16) : "";
  return /^\d{2}:\d{2}$/.test(time) ? `${formatDMY(day)}, ${clockWords(time)}` : formatDMY(day);
}

const PANEL_WIDTH: Record<Kind, number> = { date: 466, "datetime-local": 466, month: 314 };
/** Tall enough to show whole, so it opens above the field rather than scrolled when below is short. */
const PANEL_HEIGHT: Record<Kind, number> = { date: 470, "datetime-local": 540, month: 330 };

export const DateField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { type: Kind }>(function DateField(
  {
    type,
    className,
    style,
    id,
    placeholder,
    disabled,
    readOnly,
    autoFocus,
    title,
    tabIndex,
    onFocus,
    value,
    defaultValue,
    onChange,
    onBlur,
    name,
    form,
    required,
    min,
    max,
    step,
    ...rest
  },
  ref,
) {
  const clock = useClock();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const valueId = useId();
  // Read from the props first, so the page the server sends already shows the date.
  const [current, setCurrent] = useState(() => String(value ?? defaultValue ?? ""));
  /** Open: where, and whether from the keyboard — the calendar then takes the focus. */
  const [open, setOpen] = useState<false | (CalendarPlacement & { keyboard: boolean })>(false);

  const setInputRef = useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      // Watched first, so a value react-hook-form sets as it registers the input is heard.
      if (el) watchValue(el, setCurrent);
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // A controlled value that moved — read from the input, which has it as the browser kept it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && el.value !== current) setCurrent(el.value);
  }, [value, current]);

  // A form's reset puts back the value the page came with, without going through the setter.
  useEffect(() => {
    const owner = inputRef.current?.form;
    if (!owner) return;
    const onReset = () => setTimeout(() => inputRef.current && setCurrent(inputRef.current.value));
    owner.addEventListener("reset", onReset);
    return () => owner.removeEventListener("reset", onReset);
  }, []);

  /** What leaving the field means to whoever listens for it — react-hook-form's "touched", say. */
  const fireBlur = useCallback(() => {
    inputRef.current?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  }, []);

  const close = useCallback(
    (refocus: boolean) => {
      setOpen(false);
      if (refocus) buttonRef.current?.focus();
      fireBlur();
    },
    [fireBlur],
  );

  useCalendarDismiss(!!open, buttonRef, panelRef, (how) => close(how === "escape"));

  function show(keyboard: boolean) {
    if (!disabled && !readOnly) setOpen({ ...placeCalendar(buttonRef.current, PANEL_WIDTH[type]), keyboard });
  }

  function commit(next: string) {
    const el = inputRef.current;
    if (el && el.value !== next) writeValue(el, next);
    setCurrent(el?.value ?? next);
  }

  const text = shown(type, current);
  const today = todayOn(clock);

  return (
    <span className="contents">
      <button
        {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
        ref={buttonRef}
        type="button"
        id={id}
        title={title}
        style={style}
        tabIndex={tabIndex}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={!!open}
        aria-describedby={cn(valueId, rest["aria-describedby"]) || undefined}
        onFocus={onFocus as unknown as React.FocusEventHandler<HTMLButtonElement>}
        onBlur={() => {
          if (!open) fireBlur();
        }}
        onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
          rest.onClick?.(e as unknown as ReactMouseEvent<HTMLInputElement>);
          if (open) close(false);
          // `detail` is 0 for a click made by Enter or Space: the calendar then takes the focus.
          else show(e.detail === 0);
        }}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e as unknown as React.KeyboardEvent<HTMLInputElement>);
          if (e.key === "ArrowDown" && !open && !e.defaultPrevented) {
            e.preventDefault();
            show(true);
          }
        }}
        className={cn(className, "cursor-pointer items-center justify-between gap-2 text-left", readOnly && "cursor-default")}
      >
        <span id={valueId} className={cn("min-w-0 truncate", !text && "text-subtle")}>
          {text || placeholder || (type === "month" ? "Month, year" : type === "datetime-local" ? "DD/MM/YYYY, time" : "DD/MM/YYYY")}
        </span>
        <CalendarDays className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      </button>
      {/*
        The field the form reads: out of sight and out of the tab order, but a real input of its type.
        Whatever focuses it — a label, a form's "fix this field", react-hook-form — is sent on to the button.
      */}
      <input
        ref={setInputRef}
        type={type}
        name={name}
        form={form}
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        onBlur={onBlur}
        required={required}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        readOnly={readOnly}
        tabIndex={-1}
        aria-hidden
        onFocus={() => buttonRef.current?.focus()}
        className="pointer-events-none absolute h-px w-px opacity-0"
      />
      <CalendarPopover anchorRef={buttonRef} placement={open || null} fitHeight={PANEL_HEIGHT[type]}>
        <div ref={panelRef} role="dialog" aria-label={type === "month" ? "Choose a month" : "Choose a date"}>
          {type === "month" ? (
            <MonthPanel
              value={fromISOMonth(current)}
              min={fromISOMonth(min?.toString())}
              max={fromISOMonth(max?.toString())}
              today={today}
              focusOnMount={!!open && open.keyboard}
              onPick={(d) => {
                commit(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
                close(true);
              }}
              onClear={() => {
                commit("");
                close(true);
              }}
              onDone={() => close(true)}
            />
          ) : (
            <DayPicker
              type={type}
              value={current}
              min={min?.toString()}
              max={max?.toString()}
              today={today}
              focusOnMount={!!open && open.keyboard}
              commit={commit}
              close={close}
            />
          )}
        </div>
      </CalendarPopover>
    </span>
  );
});

/** Single days worth one click, from today. */
function dayPresets(today: Date): CalendarPreset[] {
  const at = (key: string, label: string, d: Date): CalendarPreset => ({ key, label, from: d, to: null });
  return [
    at("today", "Today", today),
    at("yesterday", "Yesterday", addDays(today, -1)),
    at("tomorrow", "Tomorrow", addDays(today, 1)),
    at("in7", "In 7 days", addDays(today, 7)),
    at("in30", "In 30 days", addDays(today, 30)),
    at("endOfMonth", "End of month", endOfMonth(today)),
  ];
}

/**
 * A day, or a day and a time. A day alone is chosen with one click, and the calendar closes; with a
 * time it stays open for the time too, until Done.
 */
function DayPicker({
  type,
  value,
  min,
  max,
  today,
  focusOnMount,
  commit,
  close,
}: {
  type: "date" | "datetime-local";
  value: string;
  min?: string;
  max?: string;
  today: Date;
  focusOnMount: boolean;
  commit: (next: string) => void;
  close: (refocus: boolean) => void;
}) {
  const withTime = type === "datetime-local";
  const day = fromISODate(value.slice(0, 10));
  const valueTime = withTime && /^\d{2}:\d{2}/.test(value.slice(11)) ? value.slice(11, 16) : "";
  // The time typed before any day was picked, kept until one is.
  const [draftTime, setDraftTime] = useState("09:00");
  const time = valueTime || draftTime;
  const presets = dayPresets(today);

  /** A day and time, kept inside `min` and `max` — the first day's earliest allowed time, say. */
  function put(d: Date | null, t = time) {
    if (!d) return commit("");
    let next = withTime ? `${toISODate(d)}T${t}` : toISODate(d);
    if (min && next < min) next = withTime ? min.slice(0, 16) : min;
    if (max && next > max) next = withTime ? max.slice(0, 16) : max;
    commit(next);
  }

  return (
    <CalendarPanel
      mode="single"
      from={day}
      onPick={(d, _to, how) => {
        put(d);
        if (!withTime && how === "grid" && d) close(true);
      }}
      presets={presets}
      activePreset={presets.find((p) => day && p.from && toISODate(p.from) === toISODate(day))?.key ?? null}
      onPreset={(p) => {
        put(p.from);
        if (!withTime) close(true);
      }}
      min={fromISODate(min?.slice(0, 10) ?? "")}
      max={fromISODate(max?.slice(0, 10) ?? "")}
      today={today}
      fieldLabels={["Date"]}
      clearLabel="Clear date"
      onClear={() => {
        commit("");
        close(true);
      }}
      onDone={() => close(true)}
      focusOnMount={focusOnMount}
    >
      {withTime && (
        <label className="mt-3 block space-y-1">
          <span className="block text-xs text-muted">Time</span>
          <span className="flex h-10 items-center rounded-xl border border-line-strong bg-surface px-3 transition-colors focus-within:border-brand">
            <input
              type="time"
              value={time}
              onChange={(e) => {
                const t = e.target.value;
                if (!t) return;
                setDraftTime(t);
                if (day) put(day, t);
              }}
              className="min-w-0 flex-1 bg-transparent text-[15px] tabular-nums text-text outline-none"
            />
          </span>
        </label>
      )}
    </CalendarPanel>
  );
}

/** A month of a year: the year with arrows either side, its twelve months, and the same foot as the calendar. */
function MonthPanel({
  value,
  min,
  max,
  today,
  focusOnMount,
  onPick,
  onClear,
  onDone,
}: {
  value: Date | null;
  min: Date | null;
  max: Date | null;
  today: Date;
  focusOnMount: boolean;
  onPick: (month: Date) => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const [year, setYear] = useState(() => (value ?? today).getFullYear());
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusOnMount) gridRef.current?.querySelector<HTMLButtonElement>("[aria-current='true'], button:not([disabled])")?.focus();
  }, [focusOnMount]);

  return (
    <div className="text-text">
      <div className="px-4 pb-4 pt-3.5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[15px] font-semibold tabular-nums">{year}</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous year"
              onClick={() => setYear((y) => y - 1)}
              className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next year"
              onClick={() => setYear((y) => y + 1)}
              className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-surface-sunken hover:text-text"
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
        <div ref={gridRef} className="grid grid-cols-3 gap-1.5" role="group" aria-label={`Months of ${year}`}>
          {MONTHS.map((name, i) => {
            const first = new Date(year, i, 1);
            const usable = (!min || first >= min) && (!max || first <= max);
            const chosen = !!value && value.getFullYear() === year && value.getMonth() === i;
            const thisMonth = today.getFullYear() === year && today.getMonth() === i;
            return (
              <button
                key={name}
                type="button"
                disabled={!usable}
                aria-label={`${name} ${year}`}
                aria-current={chosen ? "true" : undefined}
                onClick={() => onPick(first)}
                className={cn(
                  "h-10 rounded-full text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-35",
                  chosen
                    ? "bg-calendar-selected font-semibold text-calendar-selected-contrast"
                    : cn("hover:bg-surface-sunken", thisMonth && "border border-calendar-today font-semibold text-calendar-selected"),
                )}
              >
                {name.slice(0, 3)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-3">
        <button type="button" onClick={onClear} className="rounded-md px-1 py-1 text-sm text-muted transition-colors hover:text-text">
          Clear month
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
