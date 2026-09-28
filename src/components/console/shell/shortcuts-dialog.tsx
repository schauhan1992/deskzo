"use client";

import { useSyncExternalStore, type ReactNode } from "react";
import { Dialog } from "@/components/ui/dialog";
import { CONSOLE_PAGES, type ConsolePageKey } from "@/lib/console-shared/nav";

const never = () => () => {};

function readIsMac(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform || nav.platform || nav.userAgent || "");
}

/**
 * Whether this browser runs on a Mac, where the palette is ⌘K rather than Ctrl K. The server cannot
 * know, so it says "Ctrl" (the server snapshot) and a Mac corrects itself after hydration — read as an
 * external store rather than set in an effect, so the two renders never disagree.
 */
export function useIsMac(): boolean {
  return useSyncExternalStore(never, readIsMac, () => false);
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-6 min-w-6 place-items-center rounded-md border border-line-strong bg-surface-sunken px-1.5 font-mono text-[11px] font-medium text-muted shadow-sm">
      {children}
    </kbd>
  );
}

/** "then" and "or" between keys: small for the eye, still read out in order. */
const Joiner = ({ children }: { children: string }) => <span className="px-0.5 text-[11px] text-subtle">{children}</span>;

type Row = { key: string; keys: ReactNode; what: string };

function Section({ title, rows }: { title: string; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">{title}</h3>
      <dl className="divide-y divide-line">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4 py-1.5">
            <dt className="min-w-0 text-sm text-text">{row.what}</dt>
            <dd className="flex shrink-0 items-center gap-1">{row.keys}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * The shortcut sheet (`?`). Built from the same registry as the shortcuts themselves, filtered to the
 * pages this role may open — so "g b" is not offered to somebody for whom it does nothing.
 */
export function ShortcutsDialog({ open, onClose, visibleKeys }: { open: boolean; onClose: () => void; visibleKeys: ConsolePageKey[] }) {
  const mac = useIsMac();
  const mod = mac ? "⌘" : "Ctrl";

  const general: Row[] = [
    {
      key: "palette",
      what: "Search, or jump to a page",
      keys: (
        <>
          <Key>{mod}</Key>
          <Key>K</Key>
          <Joiner>or</Joiner>
          <Key>/</Key>
        </>
      ),
    },
    { key: "sheet", what: "Show these shortcuts", keys: <Key>?</Key> },
    { key: "find", what: "Go to the search box on a list", keys: <Key>f</Key> },
    { key: "close", what: "Close the palette, a dialog or a menu", keys: <Key>Esc</Key> },
  ];

  const goTo: Row[] = CONSOLE_PAGES.filter((page) => page.shortcut && visibleKeys.includes(page.key)).map((page) => ({
    key: page.key,
    what: page.label,
    keys: (
      <>
        <Key>g</Key>
        <Joiner>then</Joiner>
        <Key>{page.shortcut}</Key>
      </>
    ),
  }));

  const palette: Row[] = [
    {
      key: "move",
      what: "Move through the results",
      keys: (
        <>
          <Key>↑</Key>
          <Key>↓</Key>
        </>
      ),
    },
    { key: "open", what: "Open the highlighted result", keys: <Key>↵</Key> },
    { key: "w", what: "Only workspaces and their addresses", keys: <Key>w:</Key> },
    // Invoices and subscriptions are found for the staff who sell only; Billing is their page too.
    ...(visibleKeys.includes("billing") ? [{ key: "i", what: "Only invoices and subscriptions", keys: <Key>i:</Key> }] : []),
    { key: "s", what: "Only staff", keys: <Key>s:</Key> },
    { key: "actions", what: "Only actions", keys: <Key>&gt;</Key> },
  ];

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <div className="space-y-5">
        <Section title="Anywhere" rows={general} />
        <Section title="Go to" rows={goTo} />
        <Section title="In the palette" rows={palette} />
        <p className="text-xs text-muted">Shortcuts wait while you are typing in a field — except {mod} K, which works everywhere.</p>
      </div>
    </Dialog>
  );
}
