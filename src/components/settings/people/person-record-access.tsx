"use client";

import { useState } from "react";
import type { AccessLevel } from "@prisma/client";
import { Lock } from "lucide-react";
import { setPersonAccessLevels, type PersonLevelRow } from "@/actions/person-access";
import type { AccessAction } from "@/lib/authz/access";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { useDraftEditor } from "@/components/settings/people/person-draft";
import { cn } from "@/lib/utils";

// src/lib/authz/access.ts's ACCESS_ACTIONS: that module reads the database, so it stays on the server.
const ACCESS_ACTIONS = ["view", "edit", "delete", "assign"] as const satisfies readonly AccessAction[];

/**
 * One person's Record Access tab: for every kind of record and each action, their role's reach or one
 * of their own — saved with everything else by "Save changes" at the top of the page.
 * Edit, delete and assign can't reach wider than view; the server refuses it if they do.
 */
export function PersonRecordAccess({
  userId,
  name,
  grid,
  canEdit,
  lockedWhy,
}: {
  userId: string;
  name: string;
  grid: PersonLevelRow[];
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const [picked, setPickedRaw] = useState<Map<string, AccessLevel | null>>(() => new Map());
  // Saved and waiting for the page to bring the saved scopes back (it remounts this when they change).
  const [committed, setCommitted] = useState(false);
  const setPicked: typeof setPickedRaw = (v) => {
    setCommitted(false);
    setPickedRaw(v);
  };
  const slot = (record: string, action: string) => `${record}:${action}`;
  const ownOf = (row: PersonLevelRow, action: AccessAction): AccessLevel | null => {
    const s = slot(row.key, action);
    return picked.has(s) ? picked.get(s)! : (row.cells[action].own?.level ?? null);
  };

  const changes = grid.flatMap((row) =>
    ACCESS_ACTIONS.flatMap((action) => {
      const s = slot(row.key, action);
      if (!picked.has(s)) return [];
      const level = picked.get(s)!;
      return level === (row.cells[action].own?.level ?? null) ? [] : [{ record: row.key, action, level }];
    }),
  );

  useDraftEditor("records", committed ? 0 : changes.length, {
    label: "record access",
    save: async (options) => {
      const r = await setPersonAccessLevels(userId, changes, options);
      if (!r.ok) return r.error;
      setCommitted(true);
      return null;
    },
    discard: () => setPicked(new Map()),
  });

  return (
    <Card className="p-4">
      <h3 className="text-base font-semibold text-text">Record access for {name}</h3>
      <p className="mt-0.5 text-xs text-muted">Which records {name} reaches for each action: their role&apos;s scope, or one of their own. Edit, delete and assign can&apos;t reach wider than view.</p>
      {lockedWhy && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle">
          <Lock className="h-3.5 w-3.5" aria-hidden />
          {lockedWhy}
        </p>
      )}
      <div className="mt-4 overflow-x-auto rounded-base border border-line">
        <table className="w-full min-w-[42rem] text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
            <tr>
              <th className="px-3 py-2">Records</th>
              {ACCESS_ACTIONS.map((a) => (
                <th key={a} className="px-2 py-2 capitalize">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row) => (
              <tr key={row.key} className="border-b border-line align-top last:border-0">
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="block text-text">{row.label}</span>
                  <span className="block text-[11px] text-subtle">Own: {row.ownMeans}</span>
                </th>
                {ACCESS_ACTIONS.map((a) => {
                  const cell = row.cells[a];
                  if (cell.absent) {
                    return (
                      <td key={a} className="px-2 py-2 text-subtle">
                        —
                      </td>
                    );
                  }
                  const own = ownOf(row, a);
                  const now = own ?? cell.role;
                  const changed = !committed && picked.has(slot(row.key, a)) && own !== (cell.own?.level ?? null);
                  return (
                    <td key={a} className="px-2 py-2">
                      <Select
                        aria-label={`${row.label}, ${a}`}
                        value={own ?? ""}
                        disabled={!canEdit}
                        title={cell.why}
                        onChange={(e) => setPicked((m) => new Map(m).set(slot(row.key, a), e.target.value === "" ? null : (e.target.value as AccessLevel)))}
                        className={cn("h-8 w-full min-w-[8rem] text-xs", own !== null && "border-brand/50", now === "NONE" && "text-subtle")}
                      >
                        <option value="">{LEVEL_WORDS[cell.role]} (role)</option>
                        {row.levels.map((l) => (
                          <option key={l} value={l}>
                            {LEVEL_WORDS[l]}
                          </option>
                        ))}
                      </Select>
                      <span className="mt-1 block text-[11px] text-subtle">{changed ? "After you save." : own !== null ? "Set for them" : "From their role"}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
