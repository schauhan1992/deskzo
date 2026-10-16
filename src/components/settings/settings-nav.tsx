"use client";

import { useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ArrowUpRight, ChevronLeft, PanelLeftClose, PanelLeftOpen, Search, X } from "lucide-react";
import { activeSettingsKey, settingsForKeys } from "@/lib/settings/catalogue";
import { firstMatch, searchSettings } from "@/lib/settings/search";
import { cn } from "@/lib/utils";

/**
 * The settings sidebar.
 *
 * Replaces a horizontal strip of eight tabs that scrolled sideways on a laptop and showed every tab
 * to everybody. A vertical list has room for the labels, room for the groups, and room to grow —
 * which matters, because the last four features each added a settings screen and the strip was
 * already full at six.
 *
 * Two controls on top (owner, 16 Oct 2026): a search that narrows the list as you type — Enter opens
 * the first match, Escape clears it (src/lib/settings/search.ts) — and a button that folds the menu to
 * a strip of icons, for a settings page that wants the width. Folded or not is remembered in this
 * browser, read as the main sidebar reads its own (src/components/layout/sidebar.tsx).
 *
 * Hidden on the index itself: that page is the map, and a map does not need a legend beside it. And on
 * Users and Roles & Permissions, which need the width for their three columns and have "‹ Settings".
 */

/** Users and Roles & Permissions lay three columns out across the page and carry their own way back. */
const WIDE = ["/settings/users", "/settings/roles"];

const COLLAPSED_KEY = "deskzo-settings-nav-collapsed";

/** localStorage through `useSyncExternalStore`, so the server's render and the browser's agree. */
const collapsedStore = {
  subscribe(onChange: () => void) {
    window.addEventListener("storage", onChange);
    window.addEventListener(COLLAPSED_KEY, onChange);
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener(COLLAPSED_KEY, onChange);
    };
  },
  get(): boolean {
    try {
      return localStorage.getItem(COLLAPSED_KEY) === "true";
    } catch {
      // Private windows and blocked site data: the menu stays open.
      return false;
    }
  },
  server: () => false,
  set(collapsed: boolean) {
    try {
      localStorage.setItem(COLLAPSED_KEY, String(collapsed));
    } catch {
      // ignore — the choice just won't be remembered
    }
    window.dispatchEvent(new Event(COLLAPSED_KEY));
  },
};

export function SettingsNav({ visibleKeys }: { visibleKeys: string[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const collapsed = useSyncExternalStore(collapsedStore.subscribe, collapsedStore.get, collapsedStore.server);
  const [term, setTerm] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // The index is the map; the wide pages have the width instead.
  if (pathname === "/settings" || WIDE.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;

  // Rebuilt here rather than handed over ready-made: each entry holds an icon component, and a
  // function cannot be serialised from a server component to a client one. Keys can.
  const all = settingsForKeys(visibleKeys);
  const sections = searchSettings(all, term);
  const active = activeSettingsKey(pathname);

  if (collapsed) {
    return (
      <nav aria-label="Settings" className="shrink-0 md:w-11">
        <div className="flex gap-1 md:sticky md:top-20 md:flex-col md:items-center">
          <button
            type="button"
            onClick={() => collapsedStore.set(false)}
            className="flex h-9 w-9 items-center justify-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-text"
            title="Show the settings menu"
            aria-label="Show the settings menu"
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              collapsedStore.set(false);
              // The menu opens on the next render; the search box is there by then.
              requestAnimationFrame(() => searchRef.current?.focus());
            }}
            className="flex h-9 w-9 items-center justify-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-text"
            title="Search settings"
            aria-label="Search settings"
          >
            <Search className="h-4 w-4" />
          </button>
          {/* Every setting as its icon, the one open marked — still one click away. On a phone, only the two buttons. */}
          <ul className="hidden md:mt-1 md:flex md:max-h-[calc(100vh-11rem)] md:flex-col md:items-center md:gap-0.5 md:overflow-y-auto md:border-t md:border-line md:pt-2">
            {all.flatMap((section) =>
              section.groups.flatMap((group) =>
                group.items.map((item) => (
                  <li key={item.key}>
                    <Link
                      href={item.href}
                      title={item.label}
                      aria-label={item.label}
                      aria-current={active === item.key ? "page" : undefined}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-base transition-colors",
                        active === item.key ? "bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                    </Link>
                  </li>
                )),
              ),
            )}
          </ul>
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Settings" className="shrink-0 md:w-56">
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link href="/settings" className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text">
          <ChevronLeft className="h-4 w-4" />
          All settings
        </Link>
        <button
          type="button"
          onClick={() => collapsedStore.set(true)}
          className="hidden h-8 w-8 items-center justify-center rounded-base text-subtle transition-colors hover:bg-surface-sunken hover:text-text md:flex"
          title="Hide the settings menu"
          aria-label="Hide the settings menu"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      {/* Scrolls with the page on a phone, sticks beside it from md up. */}
      <div className="space-y-5 md:sticky md:top-20 md:max-h-[calc(100vh-6rem)] md:overflow-y-auto md:pb-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTerm("");
              if (e.key === "Enter") {
                const first = firstMatch(sections);
                if (first && term.trim()) {
                  setTerm("");
                  router.push(first.href);
                }
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-8 w-full rounded-base border border-line bg-surface pl-8 pr-7 text-sm text-text placeholder:text-subtle focus:border-brand focus:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
          {term && (
            <button
              type="button"
              onClick={() => {
                setTerm("");
                searchRef.current?.focus();
              }}
              className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-subtle hover:text-text"
              aria-label="Clear the search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {sections.length === 0 && <p className="px-2 text-sm text-subtle">No setting matches &ldquo;{term.trim()}&rdquo;.</p>}

        {sections.map((section) => (
          <div key={section.key}>
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{section.label}</p>
            <div className="mt-1.5 space-y-3">
              {section.groups.map((group) => (
                <div key={group.key}>
                  <p className="px-2 text-xs text-subtle">{group.label}</p>
                  <ul className="mt-0.5">
                    {group.items.map((item) => (
                      <li key={item.key}>
                        <Link
                          href={item.href}
                          onClick={() => setTerm("")}
                          aria-current={active === item.key ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-2 rounded-base px-2 py-1.5 text-sm transition-colors",
                            active === item.key ? "bg-brand-subtle font-medium text-brand" : "text-muted hover:bg-surface-sunken hover:text-text",
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">{item.label}</span>
                          {/*
                            Marked, because clicking it leaves Settings. Following a link into
                            /accounting and finding the settings sidebar gone reads as a bug unless
                            you were told it would happen.
                          */}
                          {item.external && <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-subtle" />}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
