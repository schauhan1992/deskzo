"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Row selection for a paginated table.
 *
 * Selection is deliberately scoped to the rows currently on screen: with server-side pagination the
 * component has never seen the other pages, so a "select all" that silently included them would be
 * claiming more than it knows. Anything no longer in `rows` drops out of the selection when the
 * page changes, so a bulk action can't act on a row the user can't see.
 */
export function useRowSelection<T extends { id: string }>(rows: T[]) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const visibleIds = rows.map((r) => r.id);
  const visibleSelected = visibleIds.filter((id) => selected.has(id));
  const allSelected = rows.length > 0 && visibleSelected.length === rows.length;

  return {
    /** Ids that are both selected and on the current page — what a bulk action should act on. */
    ids: visibleSelected,
    count: visibleSelected.length,
    allSelected,
    isSelected: (id: string) => selected.has(id),
    toggle(id: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    toggleAll() {
      setSelected(allSelected ? new Set() : new Set(visibleIds));
    },
    clear() {
      setSelected(new Set());
    },
  };
}

export function Checkbox({
  label,
  className,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  /**
   * What this box is called, read before every interaction.
   *
   * Defaults to the one thing this file knows a tick box here is for. A box that means something
   * else — a setting, a row of a form — should say so, either through this or through `aria-label`.
   */
  label?: string;
}) {
  return (
    <input
      type="checkbox"
      /*
       * Only when a caller gives one, and never a default.
       *
       * `label ?? "Select"` was wrong in a way that is worse than leaving it off. About twenty call
       * sites name this checkbox by wrapping it — `<label><Checkbox /> Include cancelled</label>` —
       * and in the accessible-name computation `aria-label` outranks a wrapping label. So a generic
       * default did not fill a gap; it *replaced* twenty real names with the word "Select", turning
       * "Include cancelled orders" and "Notify the employee" into the same anonymous box. Verified
       * in a browser rather than argued from the spec.
       *
       * Declared before the spread so a caller's own `aria-label` still wins — the tables pass a
       * per-row "Select Acme Ltd", which is what distinguishes one checkbox in a `.map()` from the
       * next.
       */
      {...(label ? { "aria-label": label } : {})}
      className={cn("h-4 w-4 cursor-pointer rounded-sm accent-[var(--brand)]", className)}
      {...props}
    />
  );
}

/** The toolbar that appears above a table once something is ticked. Actions are passed as children. */
export function BulkBar({
  count,
  onClear,
  error,
  notice,
  children,
}: {
  count: number;
  onClear: () => void;
  error?: string | null;
  notice?: string | null;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mb-3 animate-fade-in rounded-lg border border-line-strong bg-surface-sunken px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-text">{count} selected</span>
        <button type="button" className="mr-2 text-sm text-muted hover:text-text" onClick={onClear}>
          Clear
        </button>
        {children}
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {notice && <p className="mt-2 text-sm text-success">{notice}</p>}
    </div>
  );
}
