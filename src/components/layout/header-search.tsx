"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ChevronDown, CornerDownLeft, Loader2, Search, X } from "lucide-react";
import { searchRecords } from "@/actions/search";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import {
  SEARCH_MIN_LENGTH,
  SEARCH_SCOPE_STORAGE_KEY,
  refShortcut,
  searchListHref,
  searchScope,
  type SearchHit,
  type SearchScopeKey,
} from "@/lib/search/scopes";
import { cn } from "@/lib/utils";

type ScopeOption = { key: SearchScopeKey; label: string; listPath: string };

/** Long enough that a word typed at speed sends one request, short enough to feel immediate. */
const DEBOUNCE_MS = 220;

/**
 * The search box at the left of the header — "Search in Customers ( / )".
 *
 * The magnifier opens a list of what can be searched; the choice is remembered per browser. Typing
 * shows the first few matches as you go, Enter on a match opens it, and Enter with nothing
 * highlighted opens that list's own page filtered by the text — so the box is a shortcut into the
 * lists people already know, not a second way of reading data. What it may find is decided by the
 * same list actions: see src/actions/search.ts.
 *
 * "/" anywhere on a page that is not a text field jumps here, as it does in most tools with a search
 * box. On a phone it is an icon that opens the box across the header.
 */
export function HeaderSearch({ scopes }: { scopes: ScopeOption[] }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const scope = scopes.find((s) => s.key === stored) ?? scopes[0];

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  /** Phones: the box is folded into an icon until tapped. */
  const [expanded, setExpanded] = useState(false);
  const [results, setResults] = useState<{ for: string; hits: SearchHit[]; more: boolean; error: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  /** The newest request wins: an answer for "ac" must not replace one already shown for "acme". */
  const latest = useRef(0);

  const trimmed = query.trim();
  const searchable = trimmed.length >= SEARCH_MIN_LENGTH;
  const shortcut = scope ? refShortcut(searchScope(scope.key)!, trimmed) : null;
  const current = results && results.for === `${scope?.key}:${trimmed}` ? results : null;
  const hits = current?.hits ?? [];

  // Rows the arrows reach: the ref shortcut, the matches, then "See all results".
  const rows: { href: string; key: string }[] = [
    ...(shortcut ? [{ href: shortcut.href, key: "ref" }] : []),
    ...hits.map((h) => ({ href: h.href, key: h.id })),
    ...(scope && searchable ? [{ href: searchListHref(searchScope(scope.key)!, trimmed), key: "all" }] : []),
  ];

  const close = useCallback(() => {
    setOpen(false);
    setExpanded(false);
  }, []);

  const go = useCallback(
    (href: string) => {
      close();
      setQuery("");
      inputRef.current?.blur();
      router.push(href);
    },
    [close, router],
  );

  const { activeIndex, comboboxProps, listboxProps, optionProps } = useComboboxKeyboard({
    label: scope ? `${scope.label} matching “${trimmed}”` : "Results",
    optionCount: open && searchable ? rows.length : 0,
    isOpen: open && searchable,
    setOpen,
    onChoose: (index) => rows[index] && go(rows[index].href),
    resetKey: `${scope?.key}:${trimmed}:${hits.length}`,
  });

  // Debounced lookup. Keyed on the scope as well as the text, so switching from Customers to Orders
  // with "acme" still in the box searches again rather than showing customers under an Orders label.
  useEffect(() => {
    if (!scope || !searchable) return;
    const id = ++latest.current;
    const key = `${scope.key}:${trimmed}`;
    const timer = setTimeout(() => {
      startTransition(async () => {
        try {
          const res = await searchRecords(scope.key, trimmed);
          if (id !== latest.current) return;
          setResults(res.ok ? { for: key, hits: res.hits, more: res.more, error: null } : { for: key, hits: [], more: false, error: res.error });
        } catch {
          // A lapsed session or a dropped connection costs the preview, not the page — Enter still
          // opens the list, which will say what is wrong in full.
          if (id === latest.current) setResults({ for: key, hits: [], more: false, error: "Search isn't answering — press Enter to open the list instead." });
        }
      });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [scope, trimmed, searchable]);

  // "/" jumps to the box — unless somebody is typing somewhere, where "/" is just a character.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      event.preventDefault();
      setExpanded(true);
      // After the phone layout has had a frame to unfold the box.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!scope) return null;

  function chooseScope(key: string) {
    try {
      window.localStorage.setItem(SEARCH_SCOPE_STORAGE_KEY, key);
    } catch {
      // Private browsing: the choice holds for this page and is simply not remembered.
    }
    window.dispatchEvent(new Event(SEARCH_SCOPE_STORAGE_KEY));
    inputRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    comboboxProps.onKeyDown(event);
    if (event.defaultPrevented) return;
    if (event.key === "Enter" && trimmed) {
      event.preventDefault();
      go(searchListHref(searchScope(scope!.key)!, trimmed));
    } else if (event.key === "Escape") {
      // Nothing open to dismiss, so Escape leaves the box — and on a phone folds it away.
      event.preventDefault();
      inputRef.current?.blur();
      close();
    }
  }

  const showPanel = open && searchable;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        aria-label={`Search in ${scope.label}`}
        className="grid h-9 w-9 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text sm:hidden"
      >
        <Search className="h-[18px] w-[18px]" />
      </button>

      <div
        className={cn(
          "min-w-0 items-center",
          expanded ? "absolute inset-x-0 top-0 z-30 flex h-14 gap-2 bg-surface px-3" : "relative hidden max-w-md flex-1 sm:flex",
        )}
        onBlur={(event) => {
          // Clicking a result moves focus into the panel, which is still "in" the search.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
        }}
      >
        <div className="relative flex h-9 min-w-0 flex-1 items-center rounded-base border border-line bg-surface-sunken transition-colors focus-within:border-brand focus-within:bg-surface">
          {/* The scope picker: a real <select>, laid invisibly over the icon, so it has the keyboard,
              screen-reader and phone behaviour of one without a custom menu to get wrong. */}
          <div className="relative flex h-full shrink-0 items-center gap-0.5 border-r border-line pl-2.5 pr-1.5 text-muted hover:text-text">
            <Search className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
            <select
              aria-label="Search in"
              value={scope.key}
              onChange={(e) => chooseScope(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              {scopes.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder={`Search in ${scope.label} ( / )`}
            aria-label={`Search in ${scope.label}`}
            autoComplete="off"
            spellCheck={false}
            maxLength={100}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-text placeholder:text-subtle focus:outline-none [&::-webkit-search-cancel-button]:hidden"
            {...comboboxProps}
            onKeyDown={onKeyDown}
          />
          {pending && <Loader2 className="mr-2 h-3.5 w-3.5 shrink-0 animate-spin text-subtle" aria-hidden="true" />}
          {query && !pending && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="Clear search"
              className="mr-1.5 rounded-base p-0.5 text-subtle hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {expanded && (
          <button type="button" onClick={close} className="shrink-0 text-sm text-muted hover:text-text sm:hidden">
            Cancel
          </button>
        )}

        {showPanel && (
          <div
            className={cn(
              "absolute top-full z-30 mt-1 overflow-hidden rounded-lg border border-line bg-surface shadow-lg",
              expanded ? "inset-x-3" : "inset-x-0",
            )}
          >
            <div {...listboxProps} className="max-h-[60vh] overflow-y-auto py-1">
              {rows.map((row, index) => {
                const active = index === activeIndex;
                const base = cn("flex w-full items-center gap-3 px-3 py-2 text-left", active ? "bg-brand-subtle" : "hover:bg-surface-sunken");
                if (row.key === "ref" && shortcut) {
                  return (
                    <Link
                      key="ref"
                      href={row.href}
                      onClick={(e) => {
                        e.preventDefault();
                        go(row.href);
                      }}
                      className={base}
                      {...optionProps(index)}
                    >
                      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-brand" />
                      <span className="text-sm font-medium text-text">{shortcut.label}</span>
                    </Link>
                  );
                }
                if (row.key === "all") {
                  return (
                    <Link
                      key="all"
                      href={row.href}
                      onClick={(e) => {
                        e.preventDefault();
                        go(row.href);
                      }}
                      className={cn(base, "border-t border-line text-sm text-brand")}
                      {...optionProps(index)}
                    >
                      <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 truncate">
                        {current?.more ? "See all results" : "Open the list"} in {scope.label} for “{trimmed}”
                      </span>
                    </Link>
                  );
                }
                const hit = hits.find((h) => h.id === row.key)!;
                return (
                  <Link
                    key={hit.id}
                    href={hit.href}
                    onClick={(e) => {
                      e.preventDefault();
                      go(hit.href);
                    }}
                    className={base}
                    {...optionProps(index)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-text">{hit.title}</span>
                      {hit.subtitle && <span className="block truncate text-xs text-subtle">{hit.subtitle}</span>}
                    </span>
                  </Link>
                );
              })}
            </div>
            {current && hits.length === 0 && (
              <p className="border-t border-line px-3 py-2.5 text-xs text-muted">
                {current.error ?? `No ${scope.label.toLowerCase()} match “${trimmed}” that you can see.`}
              </p>
            )}
            {!current && (
              <p className="border-t border-line px-3 py-2.5 text-xs text-subtle" aria-live="polite">
                Searching {scope.label.toLowerCase()}…
              </p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(SEARCH_SCOPE_STORAGE_KEY, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SEARCH_SCOPE_STORAGE_KEY, onChange);
  };
}

function getSnapshot(): string | null {
  try {
    return window.localStorage.getItem(SEARCH_SCOPE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** The first scope on the server; the remembered one once mounted. */
function getServerSnapshot(): string | null {
  return null;
}
