"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useTransition } from "react";
import { Columns3, RotateCcw, Check } from "lucide-react";
import { setTableColumns, resetTableColumns } from "@/actions/table-preference";
import {
  getTableDefinition,
  resolveColumns,
  isDefaultSelection,
  isFieldChoice,
  fieldOfChoice,
  fieldChoice,
  showsField,
} from "@/lib/tables/registry";
import { AnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * Per-user column visibility for records tables.
 *
 * ## Why a context rather than a prop
 *
 * Every table here is a client component fed rows by a server page. Threading the preference down
 * would mean editing all ~18 pages as well as all ~18 tables, and a table rendered inside a tab
 * three levels deep would need the prop passed through components with no other reason to know
 * about it. The layout reads every preference once and provides them here.
 *
 * It also avoids the flash: a table that fetched its own preference on mount would render default
 * columns first and then rearrange itself, which reads as a bug every time.
 *
 * ## The invariant
 *
 * `show(key)` is called twice per column — once in the header, once in the body — and both calls
 * must use the same key. If they diverge the header and the rows disagree about how many cells
 * there are, every row below shifts one across, and it looks like bad data rather than a rendering
 * fault. `npm run check:tables` compares the two sets for every registered table, which is what
 * makes this safe to apply across twenty screens.
 *
 * Use `count` for the `colSpan` on empty-state rows. Hardcoding it is the other way this breaks.
 *
 * The workspace's own fields follow the same rule by construction rather than by check: a table
 * filters its field columns once, through `showCustom`, and hands that one list to both the header
 * cells and the row cells (src/components/custom-fields/custom-field-cells.tsx), adding its length to
 * `count` for the `colSpan`.
 */

type Preferences = Record<string, string[]>;

const TableColumnsContext = createContext<{
  preferences: Preferences;
  setPreference: (tableKey: string, columns: string[]) => void;
  clearPreference: (tableKey: string) => void;
}>({ preferences: {}, setPreference: () => {}, clearPreference: () => {} });

export function TableColumnsProvider({ initial, children }: { initial: Preferences; children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(initial);

  const setPreference = useCallback((tableKey: string, columns: string[]) => {
    setPreferences((prev) => ({ ...prev, [tableKey]: columns }));
  }, []);

  /**
   * Removes the key entirely rather than writing the defaults into it.
   *
   * The two look identical today and diverge the moment a new column ships: an absent key tracks
   * the registry, while a stored copy of today's defaults freezes this table forever.
   */
  const clearPreference = useCallback((tableKey: string) => {
    setPreferences((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, tableKey)) return prev;
      const next = { ...prev };
      delete next[tableKey];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ preferences, setPreference, clearPreference }),
    [preferences, setPreference, clearPreference],
  );
  return <TableColumnsContext.Provider value={value}>{children}</TableColumnsContext.Provider>;
}

export type TableColumns = {
  show: (key: string) => boolean;
  /**
   * Whether one of the workspace's own fields is a column here: this person's choice in the picker,
   * or the field's default (`default` from src/lib/custom-fields/server.ts `listColumns`) without one.
   */
  showCustom: (key: string, byDefault: boolean) => boolean;
  /** Visible column count, for `colSpan` — the registry's columns; a table adds its field columns. */
  count: number;
  visible: string[];
};

/**
 * What a table asks for.
 *
 * Shows everything when the table is not in the registry, deliberately: an unregistered table must
 * render exactly as it did before rather than collapsing to nothing the moment somebody imports
 * this hook.
 */
export function useColumns(tableKey: string): TableColumns {
  const { preferences } = useContext(TableColumnsContext);
  const def = getTableDefinition(tableKey);

  return useMemo(() => {
    if (!def) return { show: () => true, showCustom: (_key: string, byDefault: boolean) => byDefault, count: 0, visible: [] };
    const stored = Object.prototype.hasOwnProperty.call(preferences, tableKey) ? preferences[tableKey]! : null;
    const visible = resolveColumns(tableKey, stored);
    const set = new Set(visible);
    return {
      show: (key: string) => set.has(key),
      // A table whose picker doesn't offer the fields has no choices about them to read.
      showCustom: (key: string, byDefault: boolean) => (def.customFields ? showsField(stored, key, byDefault) : byDefault),
      count: visible.length,
      visible,
    };
  }, [def, preferences, tableKey]);
}

/** The picker. Drop it beside a table's filters. */
export function ColumnPicker({
  tableKey,
  className,
  omit,
  customColumns,
}: {
  tableKey: string;
  className?: string;
  /** Columns not offered here: one that means nothing in this workspace, like Branch with a single branch. */
  omit?: string[];
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`),
   * offered under "Your fields" on a table that shows them, each starting as its own default.
   */
  customColumns?: { key: string; label: string; default: boolean }[];
}) {
  const { preferences, setPreference, clearPreference } = useContext(TableColumnsContext);
  const def = getTableDefinition(tableKey);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  const stored =
    def && Object.prototype.hasOwnProperty.call(preferences, tableKey) ? preferences[tableKey]! : null;
  // Both memoised on the stored value rather than on `visible`: a fresh array every render would
  // rebuild the Set every render, which is what the exhaustive-deps warning is pointing at.
  const visible = useMemo(() => (def ? resolveColumns(tableKey, stored) : []), [def, tableKey, stored]);
  const chosen = useMemo(() => new Set(visible), [visible]);

  if (!def) return null;

  const fields = def.customFields ? (customColumns ?? []) : [];
  const isDefault = isDefaultSelection(tableKey, stored, fields);
  const offered = omit?.length ? def.columns.filter((c) => !omit.includes(c.key)) : def.columns;
  const hiddenCount =
    offered.filter((c) => !chosen.has(c.key)).length + fields.filter((f) => !showsField(stored, f.key, f.default)).length;
  // The choices already made about fields, carried through a change to a built-in column as they are:
  // a field nobody has chosen about goes on following its own default.
  const fieldChoices = (stored ?? []).filter(isFieldChoice);

  // The context is updated first so the table re-renders on the click, and the write follows. A
  // checkbox that does nothing for 300ms and then jumps gets clicked twice.
  const save = (next: string[]) => {
    setPreference(tableKey, next);
    startTransition(async () => {
      await setTableColumns(tableKey, next);
    });
  };

  const toggle = (key: string) =>
    save([...(chosen.has(key) ? visible.filter((k) => k !== key) : [...visible, key]), ...fieldChoices]);

  const toggleField = (field: { key: string; default: boolean }) =>
    save([
      ...visible,
      ...fieldChoices.filter((c) => fieldOfChoice(c) !== field.key),
      fieldChoice(field.key, !showsField(stored, field.key, field.default)),
    ]);

  const reset = () => {
    clearPreference(tableKey);
    startTransition(async () => {
      await resetTableColumns(tableKey);
    });
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-sm font-medium text-muted hover:bg-surface-sunken hover:text-text ${className ?? ""}`}
      >
        <Columns3 className="h-3.5 w-3.5" />
        Columns
        {hiddenCount > 0 && (
          <span className="rounded-full bg-brand-subtle px-1.5 text-[11px] font-semibold text-brand">
            {hiddenCount}
          </span>
        )}
      </button>

      <AnchoredPopover anchorRef={anchorRef} open={open} width={272} align="end">
        <div className="p-1" onMouseLeave={() => setOpen(false)}>
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-subtle">{def.label}</span>
            {!isDefault && (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-text"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto">
            {offered.map((col) => {
              const on = chosen.has(col.key);
              return (
                <button
                  key={col.key}
                  type="button"
                  aria-pressed={on}
                  disabled={col.required}
                  title={col.required ? "This column can't be hidden." : col.hint}
                  onClick={() => toggle(col.key)}
                  className={`flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm ${
                    col.required ? "cursor-not-allowed opacity-50" : "hover:bg-surface-sunken"
                  }`}
                >
                  <span
                    className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                      on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong"
                    }`}
                  >
                    {on && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-text">{col.label}</span>
                    {col.hint && <span className="block text-xs leading-snug text-subtle">{col.hint}</span>}
                  </span>
                </button>
              );
            })}

            {fields.length > 0 && (
              <>
                <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                  Your fields
                </div>
                {fields.map((field) => {
                  const on = showsField(stored, field.key, field.default);
                  return (
                    <button
                      key={fieldChoice(field.key, true)}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleField(field)}
                      className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-sunken"
                    >
                      <span
                        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                          on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong"
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 text-text">{field.label}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>

          {visible.length <= 2 && (
            <p className="border-t border-line px-2 py-1.5 text-xs text-warning">
              Almost everything is hidden. Reset brings the table back.
            </p>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}
