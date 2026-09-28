"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";

/**
 * The typing-and-picking half of a list's filters. Each control keeps its value in the URL and
 * writes it with `router.replace` — a filter is a refinement of the page you are on, not a page to
 * go Back through one keystroke at a time. Changing any of them drops the paging (`page`, `cursor`):
 * narrowing a list while standing on page 3 would otherwise show an empty page 3 of a one-page result.
 *
 * The server whitelists and clamps every param again (src/lib/console-shared/params.ts); nothing
 * here is trusted.
 */

const PAGING = ["page", "cursor"];
const MAX_QUERY = 100;

/**
 * Writes `changes` into the current URL (null or "" removes a key) and resets the paging. Only ever
 * called from handlers and timers, so it reads the address as it is *now*: a search that fires 300 ms
 * after the keystroke must not undo a filter chosen in between. The browser's own path is the one to
 * write back — the proxy rewrites admin.<domain>/x to /platform-console/x, and only the former is a
 * URL the browser can be sent to.
 */
function useParamWriter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (changes: Record<string, string | null>, resetParams: string[]) => {
    const live = typeof window !== "undefined";
    const path = live ? window.location.pathname : pathname;
    const params = new URLSearchParams(live ? window.location.search : searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.replace(query ? `${path}?${query}` : path, { scroll: false });
  };
}

/**
 * The list's search box. Debounced in the change handler (300 ms, Enter searches at once); the
 * pending search is dropped if the page unmounts, so leaving mid-word never drags you back here.
 */
export function SearchField({
  param = "q",
  label,
  placeholder,
  resetParams = PAGING,
  className,
}: {
  param?: string;
  label: string;
  placeholder?: string;
  resetParams?: string[];
  className?: string;
}) {
  const searchParams = useSearchParams();
  const write = useParamWriter();
  const current = searchParams.get(param) ?? "";

  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);
  // The URL changed from elsewhere (a removed chip, "Clear filters", Back): follow it. Our own
  // write lands here too, but by then `synced` already holds it, so typing is never overwritten.
  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  function commit(next: string) {
    window.clearTimeout(timer.current);
    const q = next.trim().slice(0, MAX_QUERY);
    if (q === current.trim()) return;
    setSynced(q);
    write({ [param]: q || null }, resetParams);
  }

  return (
    <div className={cn("relative w-full sm:w-72", className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
      {/* No name the browser recognises and every password manager's opt-out: Chrome otherwise
          fills a saved sign-in address into the first search box after signing in. */}
      <input
        type="search"
        name={`console-search-${param}`}
        value={value}
        maxLength={MAX_QUERY}
        onChange={(e) => {
          const next = e.target.value.slice(0, MAX_QUERY);
          setValue(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => commit(next), 300);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(value);
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        data-console-search=""
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-form-type="other"
        className="h-9 w-full rounded-base border border-line-strong bg-surface pr-3 pl-8 text-sm text-text placeholder:text-subtle"
      />
    </div>
  );
}

/** Picks the option matching the URL whatever its case — the server accepts `?status=active` too. */
function matchOption(options: { value: string }[], raw: string): string {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return options.find((o) => o.value === raw)?.value ?? options.find((o) => o.value.toLowerCase() === lower)?.value ?? "";
}

export function SelectFilter({
  param,
  label,
  options,
  allLabel = "All",
  resetParams = PAGING,
}: {
  param: string;
  label: string;
  options: { value: string; label: string }[];
  allLabel?: string;
  resetParams?: string[];
}) {
  const searchParams = useSearchParams();
  const write = useParamWriter();
  const id = useId();
  const current = matchOption(options, searchParams.get(param) ?? "");

  // Shows the choice at once instead of snapping back to the old one until the new page arrives.
  const [value, setValue] = useState(current);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setValue(current);
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm whitespace-nowrap text-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          write({ [param]: e.target.value || null }, resetParams);
        }}
        className="h-9 max-w-56 rounded-base border border-line-strong bg-surface px-2.5 text-sm text-text"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A created-on / paid-on range, `yyyy-mm-dd` in the URL; the server reads it as India's calendar days. */
export function DateRangeFilter({
  label,
  fromParam = "from",
  toParam = "to",
  resetParams = PAGING,
}: {
  label: string;
  fromParam?: string;
  toParam?: string;
  resetParams?: string[];
}) {
  return (
    // Matches the trigger to the other controls in the bar (h-9, the console's radius).
    <div className="[&_[aria-haspopup=dialog]]:h-9 [&_[aria-haspopup=dialog]]:rounded-base">
      <DateRangePicker label={label} fromParam={fromParam} toParam={toParam} resetParams={resetParams} />
    </div>
  );
}

const ON = new Set(["1", "true"]);

/** A yes/no refinement ("Show acknowledged and snoozed") — `param=1` when ticked, absent otherwise. */
export function ToggleFilter({ param, label, resetParams = PAGING }: { param: string; label: string; resetParams?: string[] }) {
  const searchParams = useSearchParams();
  const write = useParamWriter();
  const current = ON.has((searchParams.get(param) ?? "").toLowerCase());

  const [checked, setChecked] = useState(current);
  const [synced, setSynced] = useState(current);
  if (current !== synced) {
    setSynced(current);
    setChecked(current);
  }

  return (
    <label className="inline-flex h-9 cursor-pointer items-center gap-2 text-sm text-text select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          setChecked(e.target.checked);
          write({ [param]: e.target.checked ? "1" : null }, resetParams);
        }}
        className="h-4 w-4 rounded border-line-strong accent-brand"
      />
      {label}
    </label>
  );
}
