"use client";

import { useEffect, useState, type KeyboardEvent, type MouseEvent } from "react";
import { compactNumber } from "@/lib/console-shared/format";
import { cn } from "@/lib/utils";

type Tab = { key: string; label: string; href: string; count?: number | null };

/**
 * Tabs over panels that are all on the page already (`TabPanel`, rendered by the server with only
 * the chosen one visible). Switching is instant — the panels' `hidden` attributes are flipped by id
 * in the event handler — and the address follows with `history.replaceState`, so a reload, a shared
 * link or a refresh after an action lands on the same tab. Each tab is still a real link to its
 * `?tab=` URL: a middle-click or Ctrl+click opens it in a new tab like any other link.
 *
 * Keyboard per the WAI-ARIA tabs pattern with manual activation: Left/Right/Home/End move between
 * tabs, Enter or Space opens one, Tab moves on into the open panel.
 */
export function ConsoleTabs({ label, idPrefix, active, tabs }: { label: string; idPrefix: string; active: string; tabs: Tab[] }) {
  const [current, setCurrent] = useState(active);
  const [seen, setSeen] = useState(active);
  // The server chose another tab (a link to ?tab=billing followed from elsewhere on the page).
  if (active !== seen) {
    setSeen(active);
    setCurrent(active);
  }
  const selected = tabs.some((t) => t.key === current) ? current : tabs[0]?.key;

  const tabId = (key: string) => `${idPrefix}-tab-${key}`;
  const panelId = (key: string) => `${idPrefix}-panel-${key}`;

  // Every render, put the panels in step with the chosen tab. The server renders each panel's
  // `hidden` from its own idea of the tab, and a flip made below by hand is invisible to React — so
  // after a later server render to a third tab, the panel opened here would otherwise stay open too.
  useEffect(() => {
    for (const t of tabs) {
      const panel = document.getElementById(`${idPrefix}-panel-${t.key}`);
      if (panel) panel.hidden = t.key !== selected;
    }
  });

  function activate(tab: Tab) {
    for (const t of tabs) {
      const panel = document.getElementById(panelId(t.key));
      if (panel) panel.hidden = t.key !== tab.key;
    }
    setCurrent(tab.key);
    window.history.replaceState(null, "", tab.href);
  }

  function onClick(e: MouseEvent<HTMLAnchorElement>, tab: Tab) {
    // Leave new-tab and new-window clicks to the browser.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    activate(tab);
  }

  function onKeyDown(e: KeyboardEvent<HTMLAnchorElement>, index: number) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === " ") {
      // Enter already arrives as a click on a link; Space does not, and would scroll the page.
      e.preventDefault();
      activate(tabs[index]);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    document.getElementById(tabId(tabs[next].key))?.focus();
  }

  return (
    // The rule under the tabs is an inset shadow: a -1px margin inside a sideways-scrolling strip
    // would add a one-pixel vertical scroll.
    <div role="tablist" aria-label={label} className="flex max-w-full gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--line)]">
      {tabs.map((tab, index) => {
        const on = tab.key === selected;
        return (
          <a
            key={tab.key}
            role="tab"
            id={tabId(tab.key)}
            href={tab.href}
            aria-controls={panelId(tab.key)}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={(e) => onClick(e, tab)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(
              "inline-flex shrink-0 items-center rounded-t-base border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              on ? "border-brand text-text" : "border-transparent text-muted hover:border-line-strong hover:text-text",
            )}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span className={cn("ml-1.5 rounded-full px-1.5 text-[11px] tabular-nums", on ? "bg-brand-subtle text-brand" : "bg-surface-sunken text-muted")}>
                {compactNumber(tab.count)}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
