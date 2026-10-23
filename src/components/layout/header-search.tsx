"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  CornerDownLeft,
  ExternalLink,
  FileText,
  LayoutGrid,
  Loader2,
  PlayCircle,
  Search,
  X,
} from "lucide-react";
import { searchEverything, searchRecords, type SearchGroup } from "@/actions/search";
import { searchableHelp, type SearchableHelp } from "@/actions/help";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { useWording } from "@/components/terms/wording-provider";
import {
  EVERYTHING,
  SEARCH_MIN_LENGTH,
  SEARCH_SCOPE_STORAGE_KEY,
  refShortcut,
  refShortcutAny,
  searchListHref,
  searchPageHref,
  searchScope,
  type SearchHit,
  type SearchScope,
  type SearchScopeKey,
} from "@/lib/search/scopes";
import { findHelp, findPages, menuPages, type SearchPage } from "@/lib/search/everything";
import type { VisibleNavSection } from "@/lib/navigation";
import { cn } from "@/lib/utils";

type ScopeOption = { key: SearchScopeKey; label: string; listPath: string };

/** Long enough that a word typed at speed sends one request, short enough to feel immediate. */
const DEBOUNCE_MS = 220;
/** Everything asks every list at once, so it waits a little longer for the typing to settle. */
const EVERYTHING_DEBOUNCE_MS = 300;

/** What the arrows move through: a reference to open, a page, a record, a piece of help, or "see all". */
type Row =
  | { kind: "ref"; key: string; href: string; label: string }
  | { kind: "page"; key: string; href: string; page: SearchPage }
  | { kind: "hit"; key: string; href: string; hit: SearchHit }
  | { kind: "help"; key: string; href: string; help: SearchableHelp }
  | { kind: "all"; key: string; href: string };

/**
 * The search box at the left of the header — "Search everything ( / )".
 *
 * Searching everything (the default, owner 23 Oct 2026) finds, as you type: a reference typed with its prefix
 * ("LEAD-123") to open straight away; the pages of your menu; the first few matches from every list you may open,
 * a group each; and the help — Deskzo's guides, articles and videos and the company's own. Enter with nothing
 * highlighted opens every result on /search. What it may find is decided by each list's own action
 * (src/actions/search.ts) and by the menu you already have, so it never shows what your lists and menu wouldn't.
 *
 * The magnifier's menu still searches one list at a time; the choice is remembered per browser. Then Enter opens
 * that list's own page filtered by the text, as before.
 *
 * "/" anywhere on a page that is not a text field jumps here, as it does in most tools with a search box. On a
 * phone it is an icon that opens the box across the header.
 */
export function HeaderSearch({ scopes, navigation }: { scopes: ScopeOption[]; navigation: VisibleNavSection[] }) {
  const router = useRouter();
  const wording = useWording();
  const inputRef = useRef<HTMLInputElement>(null);
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const scope = stored && stored !== EVERYTHING ? (scopes.find((s) => s.key === stored) ?? null) : null;
  const everything = !scope;
  const label = scope ? scope.label : "everything";

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  /** Phones: the box is folded into an icon until tapped. */
  const [expanded, setExpanded] = useState(false);
  const [results, setResults] = useState<{
    for: string;
    hits: SearchHit[];
    more: boolean;
    error: string | null;
  } | null>(null);
  const [groups, setGroups] = useState<{ for: string; groups: SearchGroup[]; error: string | null } | null>(null);
  /** The help, read once the first time somebody searches everything. */
  const [help, setHelp] = useState<SearchableHelp[] | null>(null);
  const helpAsked = useRef(false);
  const [pending, startTransition] = useTransition();
  /** The newest request wins: an answer for "ac" must not replace one already shown for "acme". */
  const latest = useRef(0);

  const trimmed = query.trim();
  const searchable = trimmed.length >= SEARCH_MIN_LENGTH;
  const fullScopes = useMemo(
    () => scopes.map((s) => searchScope(s.key)).filter((s): s is SearchScope => !!s),
    [scopes],
  );
  const pages = useMemo(() => menuPages(navigation, wording), [navigation, wording]);

  const shortcut = scope ? refShortcut(searchScope(scope.key)!, trimmed) : refShortcutAny(fullScopes, trimmed);
  const current = !everything && results && results.for === `${scope.key}:${trimmed}` ? results : null;
  const currentGroups = everything && groups && groups.for === trimmed ? groups : null;
  const hits = current?.hits ?? [];
  const foundPages = everything && searchable ? findPages(pages, trimmed) : [];
  const foundHelp = everything && searchable && help ? findHelp(help, trimmed) : [];

  // Rows the arrows reach, in the order they are drawn.
  const rows: Row[] = [];
  if (shortcut) rows.push({ kind: "ref", key: "ref", href: shortcut.href, label: shortcut.label });
  if (everything) {
    for (const page of foundPages) rows.push({ kind: "page", key: `page:${page.href}`, href: page.href, page });
    for (const group of currentGroups?.groups ?? [])
      for (const hit of group.hits) rows.push({ kind: "hit", key: `${group.key}:${hit.id}`, href: hit.href, hit });
    for (const h of foundHelp) rows.push({ kind: "help", key: `help:${h.id}`, href: h.url, help: h });
    if (searchable) rows.push({ kind: "all", key: "all", href: searchPageHref(trimmed) });
  } else {
    for (const hit of hits) rows.push({ kind: "hit", key: hit.id, href: hit.href, hit });
    if (searchable) rows.push({ kind: "all", key: "all", href: searchListHref(searchScope(scope.key)!, trimmed) });
  }
  const indexOf = (key: string) => rows.findIndex((r) => r.key === key);

  const close = useCallback(() => {
    setOpen(false);
    setExpanded(false);
  }, []);

  const go = useCallback(
    (row: Row) => {
      close();
      setQuery("");
      inputRef.current?.blur();
      // Help that leaves the app opens beside it, so the page somebody was on is still there.
      if (row.kind === "help" && row.help.external) window.open(row.href, "_blank", "noopener,noreferrer");
      else router.push(row.href);
    },
    [close, router],
  );

  const { activeIndex, comboboxProps, listboxProps, optionProps } = useComboboxKeyboard({
    label: `Results for “${trimmed}”`,
    optionCount: open && searchable ? rows.length : 0,
    isOpen: open && searchable,
    setOpen,
    onChoose: (index) => rows[index] && go(rows[index]),
    resetKey: `${scope?.key ?? EVERYTHING}:${trimmed}:${rows.length}`,
  });

  // The help, once: the first time somebody searches everything.
  useEffect(() => {
    if (!everything || !open || helpAsked.current) return;
    helpAsked.current = true;
    searchableHelp()
      .then(setHelp)
      .catch(() => setHelp([]));
  }, [everything, open]);

  // Debounced lookup. Keyed on the scope as well as the text, so switching from Customers to Orders with "acme"
  // still in the box searches again rather than showing customers under an Orders label.
  useEffect(() => {
    if (!searchable) return;
    const id = ++latest.current;
    const timer = setTimeout(
      () => {
        startTransition(async () => {
          if (!scope) {
            try {
              const res = await searchEverything(trimmed);
              if (id !== latest.current) return;
              setGroups(
                res.ok
                  ? { for: trimmed, groups: res.groups, error: null }
                  : { for: trimmed, groups: [], error: res.error },
              );
            } catch {
              if (id === latest.current)
                setGroups({
                  for: trimmed,
                  groups: [],
                  error: "Search isn't answering — press Enter to try the full results.",
                });
            }
            return;
          }
          const key = `${scope.key}:${trimmed}`;
          try {
            const res = await searchRecords(scope.key, trimmed);
            if (id !== latest.current) return;
            setResults(
              res.ok
                ? { for: key, hits: res.hits, more: res.more, error: null }
                : { for: key, hits: [], more: false, error: res.error },
            );
          } catch {
            // A lapsed session or a dropped connection costs the preview, not the page — Enter still opens the
            // list, which will say what is wrong in full.
            if (id === latest.current)
              setResults({
                for: key,
                hits: [],
                more: false,
                error: "Search isn't answering — press Enter to open the list instead.",
              });
          }
        });
      },
      scope ? DEBOUNCE_MS : EVERYTHING_DEBOUNCE_MS,
    );
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
      go({
        kind: "all",
        key: "all",
        href: scope ? searchListHref(searchScope(scope.key)!, trimmed) : searchPageHref(trimmed),
      });
    } else if (event.key === "Escape") {
      // Nothing open to dismiss, so Escape leaves the box — and on a phone folds it away.
      event.preventDefault();
      inputRef.current?.blur();
      close();
    }
  }

  const showPanel = open && searchable;
  const waiting = everything ? !currentGroups : !current;
  const nothing = everything ? !!currentGroups && rows.every((r) => r.kind === "all") : !!current && hits.length === 0;
  const placeholder = scope ? `Search in ${scope.label} ( / )` : "Search everything ( / )";

  const rowClass = (index: number) =>
    cn(
      "flex w-full items-center gap-3 px-3 py-2 text-left",
      index === activeIndex ? "bg-brand-subtle" : "hover:bg-surface-sunken",
    );
  const heading = (text: string, extra?: React.ReactNode) => (
    <div
      className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase"
      role="presentation"
    >
      <span>{text}</span>
      {extra}
    </div>
  );
  const choose = (row: Row) => (e: React.MouseEvent) => {
    e.preventDefault();
    go(row);
  };

  function hitRow(row: Extract<Row, { kind: "hit" }>) {
    const index = indexOf(row.key);
    return (
      <Link key={row.key} href={row.href} onClick={choose(row)} className={rowClass(index)} {...optionProps(index)}>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text">{row.hit.title}</span>
          {row.hit.subtitle && <span className="block truncate text-xs text-subtle">{row.hit.subtitle}</span>}
        </span>
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        aria-label={`Search ${scope ? `in ${scope.label}` : "everything"}`}
        className="grid h-9 w-9 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text sm:hidden"
      >
        <Search className="h-[18px] w-[18px]" />
      </button>

      <div
        className={cn(
          "min-w-0 items-center",
          expanded
            ? "absolute inset-x-0 top-0 z-30 flex h-14 gap-2 bg-surface px-3"
            : "relative hidden max-w-md flex-1 sm:flex",
        )}
        onBlur={(event) => {
          // Clicking a result moves focus into the panel, which is still "in" the search.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
        }}
      >
        <div className="relative flex h-9 min-w-0 flex-1 items-center rounded-base border border-line bg-surface-sunken transition-colors focus-within:border-brand focus-within:bg-surface">
          {/* What to search: a real <select>, laid invisibly over the icon, so it has the keyboard, screen-reader
              and phone behaviour of one without a custom menu to get wrong. */}
          <div className="relative flex h-full shrink-0 items-center gap-0.5 border-r border-line pr-1.5 pl-2.5 text-muted hover:text-text">
            <Search className="h-4 w-4" />
            <ChevronDown className="h-3 w-3" />
            <select
              aria-label="Search in"
              value={scope?.key ?? EVERYTHING}
              onChange={(e) => chooseScope(e.target.value)}
              className="absolute inset-0 cursor-pointer opacity-0"
            >
              <option value={EVERYTHING}>Everything</option>
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
            placeholder={placeholder}
            aria-label={`Search ${scope ? `in ${scope.label}` : "everything"}`}
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
              expanded ? "inset-x-3" : "inset-x-0 sm:min-w-[26rem]",
            )}
          >
            <div {...listboxProps} className="max-h-[70vh] overflow-y-auto py-1">
              {shortcut && (
                <Link href={shortcut.href} onClick={choose(rows[0]!)} className={rowClass(0)} {...optionProps(0)}>
                  <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-brand" />
                  <span className="text-sm font-medium text-text">{shortcut.label}</span>
                </Link>
              )}

              {everything ? (
                <>
                  {foundPages.length > 0 && heading("Pages")}
                  {rows
                    .filter((r): r is Extract<Row, { kind: "page" }> => r.kind === "page")
                    .map((row) => {
                      const index = indexOf(row.key);
                      return (
                        <Link
                          key={row.key}
                          href={row.href}
                          onClick={choose(row)}
                          className={rowClass(index)}
                          {...optionProps(index)}
                        >
                          <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-sm text-text">
                            {row.page.label}
                            <span className="text-subtle"> · {row.page.group}</span>
                          </span>
                        </Link>
                      );
                    })}

                  {(currentGroups?.groups ?? []).map((group) => (
                    <div key={group.key} role="presentation">
                      {heading(
                        group.label,
                        group.more ? (
                          <Link
                            href={searchListHref(searchScope(group.key)!, trimmed)}
                            onClick={(e) => {
                              e.preventDefault();
                              go({ kind: "all", key: "all", href: searchListHref(searchScope(group.key)!, trimmed) });
                            }}
                            tabIndex={-1}
                            className="font-medium tracking-normal text-brand normal-case hover:underline"
                          >
                            See all
                          </Link>
                        ) : null,
                      )}
                      {rows
                        .filter(
                          (r): r is Extract<Row, { kind: "hit" }> =>
                            r.kind === "hit" && r.key.startsWith(`${group.key}:`),
                        )
                        .map(hitRow)}
                    </div>
                  ))}

                  {foundHelp.length > 0 && heading("Help")}
                  {rows
                    .filter((r): r is Extract<Row, { kind: "help" }> => r.kind === "help")
                    .map((row) => {
                      const index = indexOf(row.key);
                      const Icon =
                        row.help.kind === "guide" ? BookOpen : row.help.kind === "video" ? PlayCircle : FileText;
                      return (
                        <a
                          key={row.key}
                          href={row.href}
                          target={row.help.external ? "_blank" : undefined}
                          rel={row.help.external ? "noopener noreferrer" : undefined}
                          onClick={choose(row)}
                          className={rowClass(index)}
                          {...optionProps(index)}
                        >
                          <Icon className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-text">
                              {row.help.title}
                              {row.help.external && (
                                <ExternalLink
                                  className="ml-1 inline h-3 w-3 align-[-1px] text-subtle"
                                  aria-hidden="true"
                                />
                              )}
                            </span>
                            {row.help.summary && (
                              <span className="block truncate text-xs text-subtle">{row.help.summary}</span>
                            )}
                          </span>
                          {row.help.external && <span className="sr-only"> (opens in a new tab)</span>}
                        </a>
                      );
                    })}
                </>
              ) : (
                rows.filter((r): r is Extract<Row, { kind: "hit" }> => r.kind === "hit").map(hitRow)
              )}

              {searchable && (
                <Link
                  href={rows[rows.length - 1]!.href}
                  onClick={choose(rows[rows.length - 1]!)}
                  className={cn(rowClass(rows.length - 1), "mt-1 border-t border-line text-sm text-brand")}
                  {...optionProps(rows.length - 1)}
                >
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 truncate">
                    {everything
                      ? `See all results for “${trimmed}”`
                      : `${current?.more ? "See all results" : "Open the list"} in ${scope.label} for “${trimmed}”`}
                  </span>
                </Link>
              )}
            </div>
            {nothing && (
              <p className="border-t border-line px-3 py-2.5 text-xs text-muted">
                {(everything ? currentGroups?.error : current?.error) ??
                  (everything
                    ? `Nothing you can see matches “${trimmed}”.`
                    : `No ${scope.label.toLowerCase()} match “${trimmed}” that you can see.`)}
              </p>
            )}
            {waiting && (
              <p className="border-t border-line px-3 py-2.5 text-xs text-subtle" aria-live="polite">
                Searching {label.toLowerCase()}…
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

/** Everything on the server; the remembered choice once mounted. */
function getServerSnapshot(): string | null {
  return null;
}
