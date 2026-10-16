"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { setRoleAccessLevels, type AccessRow } from "@/actions/access-levels";
import { RecordAccessGrid, slotOf, type CellChoice } from "@/components/settings/staff/record-access-grid";
import { claimsMoreThan, UNDER } from "@/lib/authz/level-order";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * A role's Record Access tab: the whole grid at once — which records people in the role reach for each
 * action. Saved through `setRoleAccessLevels`, with every rule it applies; the reason the grid can't be
 * changed is the one the server gives. (Its permissions, module by module, are the Module Access tab:
 * src/components/settings/roles/role-modules-workspace.tsx.)
 */
export function RoleRecordAccess({ roleKey, grid, gridWhy, mayManage }: { roleKey: string; grid: AccessRow[]; gridWhy: string | null; mayManage: boolean }) {
  const router = useRouter();
  const [levels, setLevels] = useState<Map<string, CellChoice>>(() => new Map());
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, start] = useTransition();
  const lockedWhy = !mayManage ? "You can review roles but not change them." : gridWhy;

  function chooseLevel(record: string, action: string, choice: CellChoice) {
    setNotice(null);
    setLevels((prev) => {
      const next = new Map(prev).set(slotOf(record, action), choice);
      const row = grid.find((r) => r.key === record);
      if (!row) return next;
      const eff = (a: "view" | "edit" | "delete" | "assign") => {
        const picked = next.get(slotOf(record, a));
        const cell = row.cells[a];
        return picked === undefined ? (cell.stored ?? cell.derived) : picked === "" ? cell.derived : picked;
      };
      // Narrowing View narrows what sits under it, as the engine and the server would.
      for (const dependent of ["edit", "delete", "assign"] as const) {
        for (const parent of UNDER[dependent]) if (claimsMoreThan(eff(dependent), eff(parent))) next.set(slotOf(record, dependent), eff(parent));
      }
      return next;
    });
  }

  const changes = grid.flatMap((row) =>
    (["view", "edit", "delete", "assign"] as const).flatMap((action) => {
      const choice = levels.get(slotOf(row.key, action));
      const saved = row.cells[action].stored ?? "";
      return choice === undefined || choice === saved ? [] : [{ record: row.key, action, level: choice === "" ? null : choice }];
    }),
  );

  const save = () =>
    start(async () => {
      setNotice(null);
      const r = await setRoleAccessLevels(roleKey, changes);
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        router.refresh();
        return;
      }
      setLevels(new Map());
      setNotice({ tone: "success", text: `Saved ${changes.length} change${changes.length === 1 ? "" : "s"}.` });
      router.refresh();
    });

  return (
    <div className="rounded-base border border-line">
      <div className="space-y-3 p-4">
        <p className="text-sm text-muted">
          Which records people in this role reach, for each action. &ldquo;As its permissions&rdquo; follows what the role&apos;s permissions have always meant; a
          level set here replaces it. Edit, delete and assign can&apos;t reach wider than view.
        </p>
        {lockedWhy && (
          <p className="flex items-start gap-2 rounded-base bg-info-bg px-3 py-2 text-sm text-info">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            {lockedWhy}
          </p>
        )}
        <RecordAccessGrid rows={grid} choices={levels} lockedWhy={lockedWhy} disabled={saving} onChange={chooseLevel} />
      </div>
      {notice && (
        <div className="px-4 pb-3">
          <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
        </div>
      )}
      {(mayManage || changes.length > 0) && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3">
          <span className="text-xs text-subtle">Enforced on the server for every request — not just hidden in the menu.</span>
          <div className="flex items-center gap-2">
            {changes.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => setLevels(new Map())} disabled={saving}>
                Discard
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={saving || changes.length === 0}>
              {saving ? "Saving…" : changes.length ? `Save ${changes.length} change${changes.length === 1 ? "" : "s"}` : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
