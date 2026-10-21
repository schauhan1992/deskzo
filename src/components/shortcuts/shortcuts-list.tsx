"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Switch } from "@/components/settings/access/switch";
import { SHORTCUTS, comboLabel, type Shortcut } from "@/lib/shortcuts/busy";

type BusyEntry = { id: string; keys: string; action: string };

const WHERE: Record<Shortcut["scope"], string | null> = {
  global: null,
  form: "while writing a voucher",
  record: "on a voucher's page",
};

const CATEGORIES: Shortcut["category"][] = ["Create", "Reports", "Voucher entry", "Records", "Menus", "Tools"];

/**
 * "?" — every key, what it does here, and what BUSY calls it (src/lib/shortcuts/busy.ts). BUSY's own list is
 * loaded when this opens rather than with every page. The switch turns BUSY's keys off in this browser for
 * somebody who'd rather the browser kept F1, F3 and F10.
 */
export function ShortcutsList({ open, onClose, enabled, onEnabled }: { open: boolean; onClose: () => void; enabled: boolean; onEnabled: (on: boolean) => void }) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState<BusyEntry[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog puts focus on its first control, the close button; the box is where a keyboard person types.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || busy) return;
    let current = true;
    void import("@/lib/shortcuts/busy-reference.json").then((m) => {
      if (current) setBusy((m.default as { shortcuts: BusyEntry[] }).shortcuts);
    });
    return () => {
      current = false;
    };
  }, [open, busy]);

  const groups = useMemo(() => {
    const q = term.trim().toLowerCase();
    const busyKeys = (s: Shortcut) =>
      [...new Set(s.busy.map((id) => busy?.find((b) => b.id === id)?.keys).filter((k): k is string => !!k))].join(" · ");
    return CATEGORIES.map((category) => ({
      category,
      rows: SHORTCUTS.filter((s) => s.category === category)
        .map((s) => ({ s, keys: s.keys.map(comboLabel).join("  /  "), inBusy: busyKeys(s) }))
        .filter(({ s, keys, inBusy }) => !q || `${s.label} ${keys} ${inBusy} ${s.note ?? ""}`.toLowerCase().includes(q)),
    })).filter((g) => g.rows.length > 0);
  }, [busy, term]);

  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" large>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          ref={inputRef}
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find a key or what it does…"
          aria-label="Find a shortcut"
          className="h-9 w-72 rounded-base border border-line-strong bg-surface px-3 text-sm text-text placeholder:text-subtle focus-visible:border-brand"
        />
        <label className="flex items-center gap-2 text-sm text-muted">
          BUSY&apos;s keys
          <Switch checked={enabled} onChange={onEnabled} label="BUSY's keys" />
        </label>
      </div>
      <p className="mt-2 text-xs text-subtle">
        BUSY&apos;s keys, as BUSY users know them. Where BUSY says Alt/Ctrl with a letter, use Alt — Ctrl with a letter stays the browser&apos;s (find,
        copy, a new tab). On a Mac, Option is Alt and ⌘ is Ctrl.
      </p>
      <div className="mt-3 max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {groups.map(({ category, rows }) => (
          <section key={category}>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{category}</h3>
            <table className="w-full text-sm">
              <thead className="sr-only">
                <tr>
                  <th>Keys</th>
                  <th>Does</th>
                  <th>In BUSY</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ s, keys, inBusy }) => (
                  <tr key={s.id} className="border-t border-line align-top">
                    <td className="w-48 py-1.5 pr-3">
                      <kbd className="whitespace-nowrap rounded border border-line bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-text">{keys}</kbd>
                    </td>
                    <td className="py-1.5 pr-3 text-text">
                      {s.label}
                      {WHERE[s.scope] && <span className="ml-1 text-xs text-subtle">— {WHERE[s.scope]}</span>}
                      {s.note && <span className="mt-0.5 block text-xs text-muted">{s.note}</span>}
                    </td>
                    <td className="w-40 py-1.5 text-xs text-subtle">{inBusy || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {groups.length === 0 && <p className="py-6 text-center text-sm text-subtle">No key matches “{term.trim()}”.</p>}
      </div>
    </Dialog>
  );
}
