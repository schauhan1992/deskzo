"use client";

import { useEffect, useRef } from "react";
import { shortcutFor, type ShortcutScope } from "@/lib/shortcuts/busy";

/**
 * A page's own shortcut keys (src/lib/shortcuts/busy.ts, scopes "form" and "record") — a voucher's form saves on
 * F2, its page goes to the next voucher on Page Down. The page registers what each key does while it is open;
 * the provider (shortcuts-provider.tsx) asks the most recently opened first, then falls back to the global keys.
 *
 * Handlers are keyed by the shortcut's id ("save", "repeat", "next-record"…). One left out leaves that key to
 * the global one, if there is one, and otherwise to the browser.
 */

export type ShortcutHandlers = Partial<Record<string, () => void>>;

type Entry = { scope: Exclude<ShortcutScope, "global">; handlers: { current: ShortcutHandlers } };

const registered: Entry[] = [];

export function useShortcuts(scope: Exclude<ShortcutScope, "global">, handlers: ShortcutHandlers) {
  const ref = useRef<ShortcutHandlers>(handlers);
  useEffect(() => {
    ref.current = handlers;
  });
  useEffect(() => {
    const entry: Entry = { scope, handlers: ref };
    registered.push(entry);
    return () => {
      const at = registered.indexOf(entry);
      if (at >= 0) registered.splice(at, 1);
    };
  }, [scope]);
}

/** What the open page does for this key, if it does anything. */
export function pageHandlerFor(event: KeyboardEvent): (() => void) | null {
  for (let i = registered.length - 1; i >= 0; i -= 1) {
    const entry = registered[i]!;
    const found = shortcutFor(event, entry.scope);
    const handler = found ? entry.handlers.current[found.id] : undefined;
    if (handler) return handler;
  }
  return null;
}

/** A word from a shortcut to the person, shown briefly by the provider — "Copied PMT/2026-27/0004". */
export const SHORTCUT_NOTICE_EVENT = "deskzo.shortcut-notice";

export function shortcutNotice(text: string) {
  window.dispatchEvent(new CustomEvent(SHORTCUT_NOTICE_EVENT, { detail: text }));
}

/** The line a key was pressed on: the nearest `data-line` around the focused field, and its `data-field`. */
export function focusedLine(): { index: number; field: string | null } | null {
  const active = document.activeElement as HTMLElement | null;
  const row = active?.closest<HTMLElement>("[data-line]");
  if (!row) return null;
  const index = Number(row.dataset.line);
  if (!Number.isInteger(index)) return null;
  return { index, field: active?.closest<HTMLElement>("[data-field]")?.dataset.field ?? null };
}
