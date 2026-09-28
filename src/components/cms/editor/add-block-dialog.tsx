"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Search } from "lucide-react";
import type { BlockType } from "@/components/site/blocks/types";
import { BLOCK_GROUPS, BLOCK_INFO } from "@/components/cms/editor/catalog";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Add block": every block type this document may use, grouped, each with its icon and one line on
 * what it is for. Type to narrow the list, arrows to move, Enter to add — or click.
 */
export function AddBlockDialog({
  open,
  onClose,
  onPick,
  allowed,
  hasPageTop,
  where,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (type: BlockType) => void;
  allowed: readonly BlockType[];
  /** The page already has a hero or page header (its h1). */
  hasPageTop: boolean;
  /** "at the end", "above “Pricing table”"… */
  where: string;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Add a block ${where}`}>
      {/* Mounted only while open, so every opening starts with an empty search. */}
      {open && <Picker allowed={allowed} hasPageTop={hasPageTop} onPick={onPick} />}
    </Dialog>
  );
}

function Picker({ allowed, hasPageTop, onPick }: { allowed: readonly BlockType[]; hasPageTop: boolean; onPick: (type: BlockType) => void }) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog puts focus on its close button in its own effect, which runs after this one: wait a
  // frame, then start where the typing is.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);
  const q = query.trim().toLowerCase();
  const matches = allowed.filter((type) => {
    if (!q) return true;
    const info = BLOCK_INFO[type];
    return info.label.toLowerCase().includes(q) || info.description.toLowerCase().includes(q) || type.toLowerCase().includes(q);
  });
  const grouped = BLOCK_GROUPS.map((group) => ({ group, types: matches.filter((t) => BLOCK_INFO[t].group === group) })).filter((g) => g.types.length);
  const ordered = grouped.flatMap((g) => g.types);
  const current = Math.min(active, Math.max(0, ordered.length - 1));
  const optionId = (type: BlockType) => `${baseId}-${type}`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, ordered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current - 1 + ordered.length) % Math.max(1, ordered.length));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, ordered.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const type = ordered[current];
      if (type) onPick(type);
    }
  };

  return (
    <div className="space-y-3 p-0.5">
      <div className="relative">
        <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-subtle" />
        <Input
          ref={inputRef}
          role="combobox"
          aria-label="Search block types"
          aria-expanded="true"
          aria-controls={`${baseId}-list`}
          aria-activedescendant={ordered[current] ? optionId(ordered[current]) : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search: text, pricing, questions…"
          className="pl-8"
        />
      </div>
      <div id={`${baseId}-list`} role="listbox" aria-label="Block types" className="max-h-[55vh] space-y-3 overflow-y-auto">
        {grouped.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">No block matches “{query}”.</p>}
        {grouped.map(({ group, types }) => (
          <div key={group} role="group" aria-labelledby={`${baseId}-g-${group.replace(/\W+/g, "")}`}>
            <p id={`${baseId}-g-${group.replace(/\W+/g, "")}`} className="px-2 pb-1 text-[11px] font-semibold tracking-[0.08em] text-subtle uppercase">
              {group}
            </p>
            {types.map((type) => {
              const info = BLOCK_INFO[type];
              const Icon = info.icon;
              const on = ordered[current] === type;
              return (
                <div
                  key={type}
                  id={optionId(type)}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setActive(ordered.indexOf(type))}
                  onClick={() => onPick(type)}
                  className={cn("flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2", on ? "bg-brand-subtle" : "hover:bg-surface-sunken")}
                >
                  <span aria-hidden="true" className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border", on ? "border-brand/30 bg-surface text-brand" : "border-line bg-surface-sunken text-muted")}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text">
                      {info.label}
                      {info.pageTop && hasPageTop && <span className="ml-2 text-xs font-normal text-warning">This page already has a main title</span>}
                    </span>
                    <span className="block text-xs leading-5 text-muted">{info.description}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-xs text-subtle">↑ ↓ to move, Enter to add, Esc to close.</p>
    </div>
  );
}
