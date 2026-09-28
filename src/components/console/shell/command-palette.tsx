"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  CornerDownLeft,
  FingerprintPattern,
  Globe,
  Handshake,
  History,
  Layers,
  LoaderCircle,
  Receipt,
  Repeat,
  RotateCw,
  Search,
  Ticket,
  UserPlus,
  Users,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { consoleSearch } from "@/actions/platform/console-shell";
import { rememberWorkspace, useRecentWorkspaces } from "@/components/console/kit/prefs";
import { IconButton } from "@/components/ui/icon-button";
import { LAYER_MODAL } from "@/components/ui/layers";
import { useComboboxKeyboard } from "@/components/ui/use-combobox-keyboard";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { CONSOLE_PAGES, NAV_GROUPS, paletteActionsFor, workspaceSlugFromPath, type ConsolePageKey } from "@/lib/console-shared/nav";
import { SELLERS, hasRole } from "@/lib/console-shared/roles";
import type { ConsoleRole, SearchKind, SearchResults } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { NavIcon } from "./nav-icons";

const MAX_QUERY = 100;
/** Server search starts at two characters, 200 ms after the last keystroke. */
const MIN_SERVER = 2;
const DEBOUNCE_MS = 200;
const FAILED = "Search failed — try again";

const KIND_ICON: Record<SearchKind, LucideIcon> = {
  workspace: Building2,
  domain: Globe,
  subscription: Repeat,
  invoice: Receipt,
  terminal: FingerprintPattern,
  staff: Users,
  plan: Layers,
  invite: Ticket,
  signup: UserPlus,
  partner: Handshake,
};

const GROUP_LABEL = new Map(NAV_GROUPS.map((g) => [g.key, g.label]));

type Parsed = {
  /** "all": every group; "actions": `>` typed, actions only; "scoped": `w:`, `i:` or `s:`, the server's groups only. */
  mode: "all" | "actions" | "scoped";
  /** What the client-side groups are filtered by. */
  text: string;
  /** What goes to `consoleSearch` — prefix and all — or null when the server is not asked. */
  server: string | null;
};

function parse(raw: string): Parsed {
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.startsWith(">")) return { mode: "actions", text: q.slice(1).trim(), server: null };
  const scope = /^([wis]):\s*/i.exec(q);
  if (scope) {
    const text = q.slice(scope[0].length).trim();
    return { mode: "scoped", text, server: text.length >= MIN_SERVER ? `${scope[1]!.toLowerCase()}:${text}` : null };
  }
  return { mode: "all", text: q, server: q.length >= MIN_SERVER ? q : null };
}

/**
 * How well `text` matches a row: 4 the label starts with it, 3 a word of it does, 2 it is somewhere in
 * the label, 1 in the row's other words (keywords, group, slug); 0 no match. Empty text matches all.
 */
function score(text: string, label: string, extra: string[] = []): number {
  if (!text) return 1;
  const t = text.toLocaleLowerCase();
  const l = label.toLocaleLowerCase();
  if (l.startsWith(t)) return 4;
  if (l.split(/[\s/·-]+/).some((word) => word.startsWith(t))) return 3;
  if (l.includes(t)) return 2;
  return extra.some((word) => word.toLocaleLowerCase().includes(t)) ? 1 : 0;
}

/** Best first; ties keep their own order (the registry's, most recent first). */
function ranked<T>(items: T[], scoreOf: (item: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, s: scoreOf(item) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

type Row =
  | { id: string; kind: "link"; label: string; subtitle?: string; href: string; icon: ReactNode; hint?: string; remember?: { slug: string; name: string } }
  | { id: string; kind: "retry"; label: string; server: string };

type Group = { key: string; label: string; rows: Row[] };

type Answer = { for: string; groups: SearchResults["groups"]; error: string | null };

/**
 * The command palette (spec §1.15): Ctrl/⌘ K, `/`, or the top bar's search field. With nothing typed
 * it offers the workspaces opened last, every page this role may open and the actions it may take from
 * here; typing filters those at once and, from two characters, asks the server (`consoleSearch`) for
 * workspaces, addresses, invoices, staff and the rest — cut to the caller's role on the server.
 *
 * It only ever navigates. An action opens the page that owns it with a param that opens its dialog
 * (`/invites?new=1`), so every confirmation lives in one place and the palette cannot change anything.
 *
 * Rendered only while open, so each opening starts empty and nothing of it reaches server markup.
 */
export function CommandPalette({ open, onClose, role, visibleKeys }: { open: boolean; onClose: () => void; role: ConsoleRole; visibleKeys: ConsolePageKey[] }) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} role={role} visibleKeys={visibleKeys} />;
}

function PaletteBody({ onClose, role, visibleKeys }: { onClose: () => void; role: ConsoleRole; visibleKeys: ConsolePageKey[] }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const recent = useRecentWorkspaces();
  // Escape, the scroll lock, the focus trap and handing focus back — see use-modal-a11y.ts.
  const { titleId, containerRef } = useModalA11y(true, onClose);

  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  /** The server query waiting for its answer, for the spinner. */
  const [searching, setSearching] = useState<string | null>(null);
  /** The newest request wins: an answer for "ac" must not replace one already asked for "acme". */
  const request = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const pending = timer;
    const latest = request;
    return () => {
      window.clearTimeout(pending.current);
      latest.current++;
    };
  }, []);

  const parsed = parse(query);
  const shownAnswer = parsed.server && answer?.for === parsed.server ? answer : null;
  const seller = hasRole(role, SELLERS);

  // ─── The rows ───────────────────────────────────────────────────────────────────────────────────
  const groups: Group[] = [];

  if (parsed.mode === "all") {
    const recentRows = ranked(recent, (w) => score(parsed.text, w.name, [w.slug])).map<Row>((w) => ({
      id: `recent:${w.slug}`,
      kind: "link",
      label: w.name,
      subtitle: w.slug,
      href: `/workspaces/${encodeURIComponent(w.slug)}`,
      icon: <History aria-hidden="true" className="h-4 w-4" />,
      remember: { slug: w.slug, name: w.name },
    }));
    if (recentRows.length) groups.push({ key: "recent", label: "Recent", rows: recentRows });

    const pages = CONSOLE_PAGES.filter((page) => visibleKeys.includes(page.key));
    const pageRows = ranked(pages, (page) => score(parsed.text, page.label, [...page.keywords, GROUP_LABEL.get(page.group) ?? ""])).map<Row>((page) => ({
      id: `page:${page.key}`,
      kind: "link",
      label: page.label,
      subtitle: GROUP_LABEL.get(page.group) ?? undefined,
      href: page.href,
      icon: <NavIcon name={page.icon} />,
      hint: page.shortcut ? `g ${page.shortcut}` : undefined,
    }));
    if (pageRows.length) groups.push({ key: "goto", label: "Go to", rows: pageRows });
  }

  if (parsed.mode === "all" || parsed.mode === "actions") {
    const actions = paletteActionsFor(role, workspaceSlugFromPath(pathname));
    const actionRows = ranked(actions, (a) => score(parsed.text, a.label)).map<Row>((a) => ({
      id: `action:${a.key}`,
      kind: "link",
      label: a.label,
      href: a.href,
      icon: <Zap aria-hidden="true" className="h-4 w-4" />,
    }));
    if (actionRows.length) groups.push({ key: "actions", label: "Actions", rows: actionRows });
  }

  if (shownAnswer) {
    for (const group of shownAnswer.groups) {
      const Icon = KIND_ICON[group.kind] ?? Search;
      groups.push({
        key: `hits-${group.kind}`,
        label: group.label,
        rows: group.hits.map<Row>((hit) => ({
          id: `hit:${hit.kind}:${hit.key}`,
          kind: "link",
          label: hit.title,
          subtitle: hit.subtitle || undefined,
          href: hit.href,
          icon: <Icon aria-hidden="true" className="h-4 w-4" />,
          remember: hit.kind === "workspace" ? { slug: hit.key, name: hit.title } : undefined,
        })),
      });
    }
    if (shownAnswer.error) groups.push({ key: "error", label: "Search", rows: [{ id: "retry", kind: "retry", label: shownAnswer.error, server: shownAnswer.for }] });
  }

  const rows = groups.flatMap((g) => g.rows);
  const indexOf = new Map(rows.map((row, i) => [row.id, i]));
  const waiting = parsed.server !== null && searching === parsed.server;

  // ─── Searching ──────────────────────────────────────────────────────────────────────────────────
  function ask(server: string, id: number) {
    consoleSearch(server).then(
      (result) => {
        if (id !== request.current) return;
        setAnswer(result.ok ? { for: server, groups: result.data.groups, error: null } : { for: server, groups: [], error: result.error || FAILED });
        setSearching(null);
      },
      () => {
        if (id !== request.current) return;
        setAnswer({ for: server, groups: [], error: FAILED });
        setSearching(null);
      },
    );
  }

  function onChange(value: string) {
    const next = value.slice(0, MAX_QUERY);
    setQuery(next);
    window.clearTimeout(timer.current);
    const id = ++request.current;
    const server = parse(next).server;
    // Nothing to ask, or already answered (a trailing space, a prefix typed and taken back).
    if (!server || (answer?.for === server && !answer.error)) {
      setSearching(null);
      return;
    }
    setSearching(server);
    timer.current = window.setTimeout(() => ask(server, id), DEBOUNCE_MS);
  }

  function choose(row: Row) {
    if (row.kind === "retry") {
      window.clearTimeout(timer.current);
      setSearching(row.server);
      ask(row.server, ++request.current);
      return;
    }
    if (row.remember) rememberWorkspace(row.remember.slug, row.remember.name);
    onClose();
    router.push(row.href);
  }

  const { activeIndex, comboboxProps, listboxProps, optionProps } = useComboboxKeyboard({
    label: "Results",
    optionCount: rows.length,
    // Always open: the palette is the list. Closing is the dialog's business (Escape, below).
    isOpen: true,
    setOpen: () => {},
    onChoose: (index) => {
      const row = rows[index];
      if (row) choose(row);
    },
    // Server hits are added after the client's rows, so their arrival moves nothing already highlighted.
    resetKey: query,
  });

  /** With something typed and nothing highlighted, Enter takes the first row — marked with ↵ so it is no surprise. */
  const enterTakes = activeIndex >= 0 ? activeIndex : parsed.text || parsed.mode !== "all" ? (rows.length > 0 ? 0 : -1) : -1;

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    // Tab is the dialog's: its focus trap moves between the field, the scope chips and Close.
    if (e.key === "Tab") return;
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    comboboxProps.onKeyDown(e);
    if (e.defaultPrevented || e.key !== "Enter") return;
    e.preventDefault();
    const row = enterTakes >= 0 ? rows[enterTakes] : undefined;
    if (row) choose(row);
  }

  function scopeTo(prefix: string) {
    onChange(`${prefix}${parsed.text}`);
    containerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }

  const typed = query.trim();
  let message: string | null = null;
  if (rows.length === 0) {
    if (waiting) message = "Searching…";
    else if (typed && parsed.text.length < MIN_SERVER && parsed.mode !== "actions") message = "Keep typing — the search starts at two characters.";
    else if (typed) message = `No matches for “${typed}”`;
    else message = "Nothing to show yet.";
  }
  const live = waiting ? "Searching…" : typed ? (rows.length ? `${rows.length} ${rows.length === 1 ? "result" : "results"}` : (message ?? "")) : "";

  const scopes = [
    { prefix: "w:", label: "workspaces" },
    ...(seller ? [{ prefix: "i:", label: "invoices" }] : []),
    { prefix: "s:", label: "staff" },
    { prefix: ">", label: "actions" },
  ];

  return createPortal(
    <div className={`fixed inset-0 ${LAYER_MODAL} px-3 sm:px-4`}>
      <div aria-hidden="true" className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative mx-auto mt-[12vh] flex max-h-[76vh] w-full max-w-xl animate-scale-in flex-col overflow-hidden rounded-xl border border-line bg-surface-raised text-left whitespace-normal shadow-lg"
      >
        <h2 id={titleId} className="sr-only">
          Command palette
        </h2>
        {/* The field draws no outline of its own; the row's bottom edge turns the focus colour instead. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 focus-within:shadow-[inset_0_-2px_0_var(--focus)]">
          <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-subtle" />
          <input
            type="text"
            value={query}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search or jump to…"
            aria-label="Search the console"
            maxLength={MAX_QUERY}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            data-1p-ignore=""
            className="h-12 min-w-0 flex-1 bg-transparent text-base text-text placeholder:text-subtle focus:outline-none"
            {...comboboxProps}
            onKeyDown={onKeyDown}
          />
          {waiting && <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-subtle" />}
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>

        <div {...listboxProps} className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1 empty:hidden">
          {groups.map((group) => {
            const headingId = `${listboxProps.id}-${group.key}`;
            return (
              <div key={group.key} role="group" aria-labelledby={headingId}>
                <div id={headingId} aria-hidden="true" className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-subtle uppercase">
                  {group.label}
                </div>
                {group.rows.map((row) => {
                  const index = indexOf.get(row.id) ?? -1;
                  const lit = index === enterTakes;
                  return (
                    <div
                      key={row.id}
                      {...optionProps(index)}
                      // Keeps focus in the field, so typing carries on after a click that missed.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(row)}
                      className={cn(
                        "flex h-10 cursor-pointer items-center gap-3 px-3 text-sm",
                        lit ? "bg-surface-sunken" : "hover:bg-surface-sunken",
                        row.kind === "retry" && "text-danger",
                      )}
                    >
                      <span className={cn("grid h-6 w-6 shrink-0 place-items-center", row.kind === "retry" ? "text-danger" : "text-subtle")}>
                        {row.kind === "retry" ? <RotateCw aria-hidden="true" className="h-4 w-4" /> : row.icon}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate leading-5", row.kind === "retry" ? "text-danger" : "text-text")}>{row.label}</span>
                        {row.kind === "link" && row.subtitle && <span className="block truncate text-xs leading-4 text-subtle">{row.subtitle}</span>}
                      </span>
                      {lit ? (
                        <CornerDownLeft aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
                      ) : (
                        row.kind === "link" &&
                        row.hint && (
                          <span aria-hidden="true" className="shrink-0 font-mono text-[11px] text-subtle">
                            {row.hint}
                          </span>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {message && <p className="shrink-0 px-3 py-8 text-center text-sm text-muted">{message}</p>}
        <div role="status" aria-live="polite" className="sr-only">
          {live}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11px] text-subtle">
          <div className="flex flex-wrap items-center gap-1.5">
            {scopes.map((scope) => (
              <button
                key={scope.prefix}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => scopeTo(scope.prefix === ">" ? ">" : `${scope.prefix} `)}
                aria-label={`Search ${scope.label} only`}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-line bg-surface-sunken px-2 text-muted transition-colors hover:border-line-strong hover:text-text"
              >
                <span aria-hidden="true" className="font-mono text-text">
                  {scope.prefix}
                </span>
                <span aria-hidden="true">{scope.label}</span>
              </button>
            ))}
          </div>
          <p aria-hidden="true" className="hidden sm:block">
            ↑↓ move · ↵ open · Esc close
          </p>
        </div>
      </div>
    </div>,
    document.body,
  );
}
