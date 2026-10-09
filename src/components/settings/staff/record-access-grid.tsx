"use client";

import type { AccessLevel } from "@prisma/client";
import type { AccessRow } from "@/actions/access-levels";
import { LEVEL_WORDS } from "@/lib/authz/level-order";

/**
 * Which records a role reaches — the grid half of the role editor (docs/permission-redesign.md §4).
 *
 * One row per record type, one column per action, one choice per cell. A cell either follows the
 * role's permissions — what it has always meant, and what every cell does until somebody chooses —
 * or holds a level chosen here. Only the levels a record type offers are listed in its row: contacts
 * have no owner of their own, and an account can't "follow the account".
 */


const ACTIONS = [
  { key: "view", label: "View" },
  { key: "edit", label: "Edit" },
  { key: "delete", label: "Delete" },
  { key: "assign", label: "Assign" },
] as const;

/** The value a cell's select holds: a level, or "" for "follows its permissions". */
export type CellChoice = AccessLevel | "";

export function slotOf(record: string, action: string) {
  return `${record}:${action}`;
}

export function RecordAccessGrid({
  rows,
  choices,
  lockedWhy,
  disabled,
  onChange,
}: {
  rows: AccessRow[];
  /** The value each cell shows now: its saved level, or the one picked since. */
  choices: Map<string, CellChoice>;
  lockedWhy: string | null;
  disabled: boolean;
  onChange: (record: string, action: string, choice: CellChoice) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-base border border-line">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
            <th scope="col" className="px-3 py-2">
              Records
            </th>
            {ACTIONS.map((a) => (
              <th key={a.key} scope="col" className="px-2 py-2">
                {a.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b border-line last:border-0 align-top">
              <th scope="row" className="px-3 py-2 text-left font-normal">
                <span className="block text-text">{row.label}</span>
                <span className="block text-xs text-subtle">Own: {row.ownMeans}</span>
              </th>
              {ACTIONS.map((a) => {
                const cell = row.cells[a.key];
                const slot = slotOf(row.key, a.key);
                const choice = choices.get(slot) ?? cell.stored ?? "";
                const follows = `As its permissions — ${LEVEL_WORDS[cell.derived]}`;
                return (
                  <td key={a.key} className="px-2 py-2">
                    <select
                      className="h-8 w-full min-w-[9rem] rounded-base border border-line bg-surface px-2 text-sm text-text disabled:opacity-60"
                      value={choice}
                      disabled={disabled || lockedWhy !== null}
                      title={
                        lockedWhy ??
                        (choice === ""
                          ? `${cell.derivedFrom.held ? "Holds" : "Doesn't hold"} "${cell.derivedFrom.label}", so ${LEVEL_WORDS[cell.derived].toLowerCase()}.`
                          : undefined)
                      }
                      aria-label={`${row.label}, ${a.label}`}
                      data-access-slot={slot}
                      onChange={(e) => onChange(row.key, a.key, e.target.value as CellChoice)}
                    >
                      <option value="">{follows}</option>
                      {row.levels.map((level) => (
                        <option key={level} value={level}>
                          {LEVEL_WORDS[level]}
                        </option>
                      ))}
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
