"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Search } from "lucide-react";
import { setRolePermissions } from "@/actions/permission";
import { setRoleAccessLevels, type AccessRow } from "@/actions/access-levels";
import { RecordAccessGrid, slotOf, type CellChoice } from "@/components/settings/staff/record-access-grid";
import { claimsMoreThan, UNDER } from "@/lib/authz/level-order";
import { ACCESS_MODULES, moduleStanding, permissionsOfModule, STANDING_WORDS, type ModuleStanding } from "@/lib/staff/access-modules";
import { moduleNote } from "@/lib/staff/permission-modules";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import type { CatalogueEntry, ModuleStates } from "@/components/settings/staff/types";

/**
 * A role's permissions and reach — the Module Access and Record Access tabs of a role.
 *
 * Module Access lays the one model out by module (src/lib/staff/access-modules.ts): for the module
 * chosen, which of its records the role reaches for each action, then each of its permissions with an
 * Allow box and the conditions the server holds it to. Record Access is the whole grid at once. Both
 * save through the actions that always saved roles — `setRolePermissions` and `setRoleAccessLevels` —
 * with every rule they apply, and the reasons a box can't be changed are the ones the server gives.
 */

export type Viewer = {
  mayManage: boolean;
  isSuperAdmin: boolean;
  /** The keys the viewer holds — the ones they may grant or take away. */
  holds: string[];
  role: string;
  /** Of the two keys that open these screens, the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
};

const STANDING_TONE: Record<ModuleStanding, "green" | "amber" | "red"> = { full: "green", limited: "amber", none: "red" };

export function RoleAccessEditor({
  view,
  roleKey,
  catalogue,
  selfExcluded,
  held,
  grid,
  gridWhy,
  modules,
  viewer,
}: {
  view: "modules" | "records";
  roleKey: string;
  catalogue: CatalogueEntry[];
  selfExcluded: string[];
  held: string[];
  grid: AccessRow[];
  gridWhy: string | null;
  modules: ModuleStates;
  viewer: Viewer;
}) {
  const router = useRouter();
  const savedHeld = useMemo(() => new Set(held), [held]);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(held));
  const [levels, setLevels] = useState<Map<string, CellChoice>>(() => new Map());
  const [active, setActive] = useState(ACCESS_MODULES[0]!.key);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, start] = useTransition();

  const byKey = useMemo(() => new Map(catalogue.map((c) => [c.key, c])), [catalogue]);
  const holds = useMemo(() => new Set(viewer.holds), [viewer.holds]);
  const excluded = useMemo(() => new Set(selfExcluded), [selfExcluded]);
  const isAdminRole = roleKey === "ADMIN";

  const lockReason = (key: string): string | null => {
    if (!viewer.mayManage) return "You can review roles but not change them.";
    if (isAdminRole && !viewer.isSuperAdmin) return "Only a super admin can change what admins can do.";
    if (viewer.isSuperAdmin) return null;
    if (byKey.get(key)?.superAdminOnly) return "Only a super admin can grant this permission.";
    if (!holds.has(key)) return "You don't hold this yourself, so you can't change it for a role.";
    if (roleKey === viewer.role && viewer.ownAccessThroughRole.includes(key) && savedHeld.has(key)) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };

  /** A cell's level as it stands with the picks made so far. */
  const effectiveLevel = (row: AccessRow, action: "view" | "edit" | "delete" | "assign") => {
    const picked = levels.get(slotOf(row.key, action));
    const cell = row.cells[action];
    return picked === undefined ? (cell.stored ?? cell.derived) : picked === "" ? cell.derived : picked;
  };

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

  const permissionChanges = catalogue.filter((c) => ticked.has(c.key) !== savedHeld.has(c.key)).map((c) => ({ key: c.key, allowed: ticked.has(c.key) }));
  const levelChanges = grid.flatMap((row) =>
    (["view", "edit", "delete", "assign"] as const).flatMap((action) => {
      const choice = levels.get(slotOf(row.key, action));
      const saved = row.cells[action].stored ?? "";
      return choice === undefined || choice === saved ? [] : [{ record: row.key, action, level: choice === "" ? null : choice }];
    }),
  );
  const changes = permissionChanges.length + levelChanges.length;

  const save = () =>
    start(async () => {
      setNotice(null);
      if (permissionChanges.length) {
        const r = await setRolePermissions(roleKey, permissionChanges);
        if (!r.ok) {
          setNotice({ tone: "error", text: r.error });
          return;
        }
      }
      if (levelChanges.length) {
        const r = await setRoleAccessLevels(roleKey, levelChanges);
        if (!r.ok) {
          setNotice({ tone: "error", text: permissionChanges.length ? `The permissions were saved, but not which records it reaches: ${r.error}` : r.error });
          router.refresh();
          return;
        }
      }
      setLevels(new Map());
      setNotice({ tone: "success", text: `Saved ${changes} change${changes === 1 ? "" : "s"}.` });
      router.refresh();
    });

  const discard = () => {
    setTicked(new Set(held));
    setLevels(new Map());
    setNotice(null);
  };

  const standing = (moduleKey: string): ModuleStanding => {
    const m = ACCESS_MODULES.find((x) => x.key === moduleKey)!;
    return moduleStanding(
      m,
      (k) => ticked.has(k),
      (r) => {
        const row = grid.find((g) => g.key === r);
        return row ? effectiveLevel(row, "view") !== "NONE" : false;
      },
    );
  };

  const levelsLocked = gridWhy;
  const saveBar = (viewer.mayManage || changes > 0) && (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-3">
      <span className="text-xs text-subtle">Enforced on the server for every request — not just hidden in the menu.</span>
      <div className="flex items-center gap-2">
        {changes > 0 && (
          <Button variant="ghost" size="sm" onClick={discard} disabled={saving}>
            Discard
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={saving || changes === 0}>
          {saving ? "Saving…" : changes ? `Save ${changes} change${changes === 1 ? "" : "s"}` : "Save changes"}
        </Button>
      </div>
    </div>
  );

  if (view === "records") {
    return (
      <div className="rounded-base border border-line">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">
            Which records people in this role reach, for each action. &ldquo;As its permissions&rdquo; follows what the role&apos;s permissions have always meant; a
            level set here replaces it. Edit, delete and assign can&apos;t reach wider than view.
          </p>
          {levelsLocked && <LockedNote text={levelsLocked} />}
          <RecordAccessGrid rows={grid} choices={levels} lockedWhy={levelsLocked} disabled={saving} onChange={chooseLevel} />
        </div>
        {notice && (
          <div className="px-4 pb-3">
            <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>
          </div>
        )}
        {saveBar}
      </div>
    );
  }

  const current = ACCESS_MODULES.find((m) => m.key === active)!;
  const term = search.trim().toLowerCase();
  const rowsHere = grid.filter((r) => current.records.includes(r.key));
  const keysHere = permissionsOfModule(current.key)
    .map((d) => byKey.get(d.key))
    .filter((c): c is CatalogueEntry => Boolean(c))
    .filter((c) => !term || c.label.toLowerCase().includes(term) || c.description.toLowerCase().includes(term));

  return (
    <div className="overflow-hidden rounded-base border border-line">
      <div className="grid md:grid-cols-[15rem_1fr]">
        <nav aria-label="Modules" className="border-b border-line bg-surface-sunken md:border-b-0 md:border-r">
          <ul className="max-h-[32rem] overflow-y-auto p-2">
            {ACCESS_MODULES.map((m) => {
              const s = standing(m.key);
              return (
                <li key={m.key}>
                  <button
                    type="button"
                    onClick={() => setActive(m.key)}
                    aria-current={active === m.key ? "true" : undefined}
                    className={`flex w-full items-start justify-between gap-2 rounded-base px-2.5 py-2 text-left text-sm ${active === m.key ? "bg-brand/10 text-text ring-1 ring-brand/30" : "text-muted hover:bg-surface"}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-text">{m.label}</span>
                      <span className="block truncate text-[11px] text-subtle">{m.description}</span>
                    </span>
                    <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${s === "full" ? "bg-success" : s === "limited" ? "bg-warning" : "bg-line-strong"}`} title={STANDING_WORDS[s]} />
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 space-y-4 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-text">{current.label}</h3>
              <p className="text-xs text-muted">{current.description}</p>
            </div>
            <Badge tone={STANDING_TONE[standing(current.key)]}>{STANDING_WORDS[standing(current.key)]}</Badge>
          </div>

          {rowsHere.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Record scope</h4>
              <RecordAccessGrid rows={rowsHere} choices={levels} lockedWhy={levelsLocked} disabled={saving} onChange={chooseLevel} />
            </div>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Actions</h4>
              <label className="relative block w-52">
                <span className="sr-only">Search actions</span>
                <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-subtle" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search actions…" className="h-8 pl-8 text-sm" />
              </label>
            </div>
            <div className="overflow-x-auto rounded-base border border-line">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
                  <tr>
                    <th className="px-3 py-2">Action</th>
                    <th className="w-20 px-3 py-2">Allow</th>
                    <th className="px-3 py-2">Conditions</th>
                  </tr>
                </thead>
                <tbody>
                  {keysHere.map((entry) => {
                    const why = lockReason(entry.key);
                    const note = moduleNote(entry.modules, modules);
                    const conditions = [
                      excluded.has(entry.key) ? "Never on their own records" : null,
                      entry.superAdminOnly ? "Granted by a super admin only" : null,
                      note,
                    ].filter(Boolean);
                    return (
                      <tr key={entry.key} className="border-b border-line last:border-0 align-top">
                        <td className="px-3 py-2.5">
                          <span className="font-medium text-text">{entry.label}</span>
                          {entry.tier === "critical" && <Badge tone="red" className="ml-1.5">Critical</Badge>}
                          {entry.tier === "sensitive" && <Badge tone="amber" className="ml-1.5">Sensitive</Badge>}
                          <span className="block text-xs text-subtle">{entry.description}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--color-brand)] disabled:opacity-50"
                            checked={ticked.has(entry.key)}
                            disabled={why !== null || saving}
                            title={why ?? undefined}
                            aria-label={`Allow ${entry.label}`}
                            onChange={(e) => {
                              setNotice(null);
                              setTicked((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(entry.key);
                                else next.delete(entry.key);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted">
                          {conditions.length ? conditions.map((c) => <span key={c} className="block">{c}</span>) : <span className="text-subtle">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                  {keysHere.length === 0 && (
                    <tr>
                      <td colSpan={3} className="px-3 py-6 text-center text-subtle">
                        {term ? `No action matches “${search}”.` : "Nothing to allow here beyond the records above."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        </div>
      </div>
      {saveBar}
    </div>
  );
}

function LockedNote({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-2 rounded-base bg-info-bg px-3 py-2 text-sm text-info">
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {text}
    </p>
  );
}
