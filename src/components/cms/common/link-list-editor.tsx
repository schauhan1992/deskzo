"use client";

import { useId, useRef } from "react";
import { ArrowDown, ArrowUp, Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { SiteLink } from "@/components/site/blocks/types";
import { cn } from "@/lib/utils";
import { LINK_HINT, TextField, hrefProblem, isMailto } from "./fields";

/**
 * A list of links an editor builds by hand — the header menu, a footer column, the not-found page's
 * suggestions: each a label and an address, added, removed and moved up or down with buttons (named
 * for the link they act on, so "Move Pricing up" is what a screen reader hears). No drag and drop:
 * the buttons are the whole of it, and they work from a keyboard.
 *
 * Rows carry a key of their own, made in the browser, so React keeps each row's inputs (and focus)
 * with the link as it moves; the key never leaves the page (`unkeyLinks`).
 */

export type KeyedLink = { key: string; label: string; href: string };

let counter = 0;
/** A fresh row key — for event handlers only, never a render. */
export const newRowKey = () => `row-${++counter}`;

export const keyLinks = (links: readonly SiteLink[], prefix: string): KeyedLink[] => links.map((l, i) => ({ key: `${prefix}-${i}`, label: l.label ?? "", href: l.href ?? "" }));
export const unkeyLinks = (links: readonly KeyedLink[]): SiteLink[] => links.map(({ label, href }) => ({ label, href }));

/** Moves one item of a list by one place; the same list when it cannot. */
export function moveItem<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

export function LinkListEditor({
  legend,
  description,
  links,
  onChange,
  max,
  basePath,
  issues,
  readOnly = false,
  addLabel = "Add a link",
  emptyText,
  labelPlaceholder = "Pricing",
  hrefPlaceholder = "/pricing",
}: {
  legend: string;
  description?: string;
  links: KeyedLink[];
  onChange: (next: KeyedLink[]) => void;
  max: number;
  /** Where the server's issues for this list point: "nav", "footer.columns[1].links". */
  basePath: string;
  issues: Record<string, string>;
  readOnly?: boolean;
  addLabel?: string;
  emptyText: string;
  labelPlaceholder?: string;
  hrefPlaceholder?: string;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  const addRef = useRef<HTMLButtonElement>(null);
  /** The row whose label takes focus once it is on screen (just added, or moved into a removed one's place). */
  const focusRow = useRef<string | null>(null);
  const full = links.length >= max;
  const listIssue = issues[basePath];

  function update(key: string, change: Partial<KeyedLink>) {
    onChange(links.map((l) => (l.key === key ? { ...l, ...change } : l)));
  }

  function add() {
    if (full) return;
    const key = newRowKey();
    focusRow.current = key;
    onChange([...links, { key, label: "", href: "" }]);
  }

  function remove(index: number) {
    const next = links.filter((_, i) => i !== index);
    // Focus goes to the row that took its place, or the one before, or the Add button.
    const neighbour = next[index] ?? next[index - 1];
    focusRow.current = neighbour?.key ?? null;
    onChange(next);
    if (!neighbour) window.requestAnimationFrame(() => addRef.current?.focus());
  }

  const focusIfPending = (key: string) => (el: HTMLInputElement | null) => {
    if (el && focusRow.current === key) {
      focusRow.current = null;
      el.focus();
    }
  };

  /** After a move, the pressed button follows its row — or its twin, when the row reached an end and the button switched off. */
  const focusMove = useRef<{ key: string; dir: "up" | "down" } | null>(null);
  function move(index: number, dir: "up" | "down") {
    const to = dir === "up" ? index - 1 : index + 1;
    const key = links[index]?.key;
    if (!key || to < 0 || to >= links.length) return;
    focusMove.current = { key, dir: to === 0 ? "down" : to === links.length - 1 ? "up" : dir };
    onChange(moveItem(links, index, dir === "up" ? -1 : 1));
  }
  const moveRef = (key: string, dir: "up" | "down") => (el: HTMLButtonElement | null) => {
    if (el && focusMove.current?.key === key && focusMove.current.dir === dir) {
      focusMove.current = null;
      el.focus();
    }
  };

  return (
    <fieldset aria-describedby={description ? descId : undefined} className="min-w-0 space-y-3">
      <legend className="text-sm font-medium text-text">
        {legend}
        <span className="ml-2 text-xs font-normal text-subtle tabular-nums">
          {links.length} of {max}
        </span>
      </legend>
      {description && (
        <p id={descId} className="-mt-1 text-xs text-muted">
          {description}
        </p>
      )}
      {listIssue && <p className="text-xs text-danger">{listIssue}</p>}

      {links.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-line px-4 py-3 text-xs text-muted">
          <Link2 aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle" />
          {emptyText}
        </div>
      ) : (
        <ol className="space-y-2">
          {links.map((link, i) => {
            const name = link.label.trim() || `link ${i + 1}`;
            const labelPath = `${basePath}[${i}].label`;
            const hrefPath = `${basePath}[${i}].href`;
            const hrefError = issues[hrefPath] ?? hrefProblem(link.href);
            return (
              <li key={link.key} className="rounded-lg border border-line bg-surface-sunken/50 p-3">
                <div className="flex items-start gap-2">
                  <span aria-hidden="true" className="mt-2 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-surface text-[11px] font-semibold text-muted tabular-nums">
                    {i + 1}
                  </span>
                  <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                    <TextField
                      label={`Label for link ${i + 1}`}
                      srOnlyLabel
                      value={link.label}
                      onChange={(v) => update(link.key, { label: v })}
                      max={80}
                      placeholder={labelPlaceholder}
                      error={issues[labelPath]}
                      readOnly={readOnly}
                      inputRef={focusIfPending(link.key)}
                    />
                    <TextField
                      label={`Address for link ${i + 1}`}
                      srOnlyLabel
                      value={link.href}
                      onChange={(v) => update(link.key, { href: v })}
                      placeholder={hrefPlaceholder}
                      error={hrefError}
                      hint={!hrefError && isMailto(link.href) ? "The site shows mailto: addresses as plain text, not as a link." : undefined}
                      readOnly={readOnly}
                      mono
                      inputMode="url"
                    />
                  </div>
                  {!readOnly && (
                    <div className="mt-1 flex shrink-0 items-center">
                      <IconButton ref={moveRef(link.key, "up")} icon={ArrowUp} label={`Move ${name} up`} onClick={() => move(i, "up")} disabled={i === 0} />
                      <IconButton ref={moveRef(link.key, "down")} icon={ArrowDown} label={`Move ${name} down`} onClick={() => move(i, "down")} disabled={i === links.length - 1} />
                      <IconButton icon={X} label={`Remove ${name}`} tone="danger" onClick={() => remove(i)} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {!readOnly && (
        <div className="flex flex-wrap items-center gap-3">
          <Button ref={addRef} type="button" variant="secondary" size="sm" onClick={add} disabled={full}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            {addLabel}
          </Button>
          <span className={cn("text-xs", full ? "text-warning" : "text-subtle")}>{full ? `That's the most this list takes (${max}).` : LINK_HINT}</span>
        </div>
      )}
    </fieldset>
  );
}
