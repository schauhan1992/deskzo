"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Star } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type PickEntry = {
  key: string;
  label: string;
  /** Beside the label, quieter — where the page is, an account's code. */
  hint?: string;
  /** Where choosing it goes; or `run`, for something that isn't a page. */
  href?: string;
  run?: () => void;
};

/**
 * The list a menu key or a picker opens (src/components/shortcuts/shortcuts-provider.tsx): a box to type in, the
 * matches under it, arrows to move and Enter to choose — BUSY's menus, the way a keyboard person wants them.
 *
 * Either `entries` filtered here as you type, or `search` asked as you type (an account, an item). Pages can be
 * starred — `favourites` — and come back on the favourites menu.
 */
export function PickList({
  open,
  title,
  placeholder,
  entries,
  search,
  emptyText,
  favourites,
  onToggleFavourite,
  onChoose,
  onClose,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  entries?: PickEntry[];
  search?: (term: string) => Promise<PickEntry[]>;
  emptyText: string;
  favourites?: ReadonlySet<string>;
  onToggleFavourite?: (href: string) => void;
  onChoose: (entry: PickEntry) => void;
  onClose: () => void;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [found, setFound] = useState<PickEntry[] | null>(null);
  const [active, setActive] = useState(0);
  // The dialog puts focus on its first control, the close button; the box is where a keyboard person types.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // Asked as you type, the last answer winning — a slow early reply can't replace a later one.
  useEffect(() => {
    if (!open || !search) return;
    let current = true;
    const timer = window.setTimeout(() => {
      search(term)
        .then((rows) => current && setFound(rows))
        .catch(() => current && setFound([]));
    }, 150);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [open, search, term]);

  const shown = useMemo(() => {
    if (search) return found ?? [];
    const q = term.trim().toLowerCase();
    const all = entries ?? [];
    return q ? all.filter((e) => e.label.toLowerCase().includes(q) || (e.hint ?? "").toLowerCase().includes(q)) : all;
  }, [entries, found, search, term]);
  const at = Math.min(active, Math.max(0, shown.length - 1));

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (shown.length === 0) return;
      setActive((a) => (event.key === "ArrowDown" ? (Math.min(a, shown.length - 1) + 1) % shown.length : (Math.min(a, shown.length - 1) - 1 + shown.length) % shown.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = shown[at];
      if (entry) onChoose(entry);
    }
  }

  // Back to the top of the list as the search changes.
  function type(value: string) {
    setTerm(value);
    setActive(0);
  }

  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <input
        ref={inputRef}
        type="search"
        value={term}
        onChange={(e) => type(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={placeholder}
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-activedescendant={shown[at] ? `${listId}-${at}` : undefined}
        className="h-10 w-full rounded-base border border-line-strong bg-surface px-3 text-sm text-text placeholder:text-subtle focus-visible:border-brand"
      />
      <ul id={listId} role="listbox" aria-label={title} className="mt-2 max-h-[55vh] overflow-y-auto">
        {search && found === null && <li className="px-3 py-6 text-center text-sm text-subtle">Looking…</li>}
        {(!search || found !== null) && shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-subtle">{emptyText}</li>}
        {shown.map((entry, i) => {
          const starred = !!entry.href && !!favourites?.has(entry.href);
          return (
            <li
              key={entry.key}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === at}
              onMouseEnter={() => setActive(i)}
              onClick={() => onChoose(entry)}
              className={cn("flex cursor-pointer items-center gap-3 rounded-base px-3 py-2 text-sm", i === at ? "bg-brand-subtle text-brand" : "text-text hover:bg-surface-sunken")}
            >
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="shrink-0 truncate text-xs text-subtle">{entry.hint}</span>}
              {entry.href && onToggleFavourite && (
                <button
                  type="button"
                  aria-label={starred ? `Remove ${entry.label} from favourites` : `Add ${entry.label} to favourites`}
                  aria-pressed={starred}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavourite(entry.href!);
                  }}
                  className="shrink-0 rounded p-1 text-subtle hover:text-warning"
                >
                  <Star aria-hidden="true" className={cn("h-3.5 w-3.5", starred && "fill-warning text-warning")} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-subtle">↑ ↓ to move · Enter to open · Esc to close</p>
    </Dialog>
  );
}
