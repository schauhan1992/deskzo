"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AccessLevel } from "@prisma/client";
import { ChevronRight, Lock, RotateCcw, Search } from "lucide-react";
import { setRolePermissions } from "@/actions/permission";
import { setRoleAccessLevels, type AccessChange, type AccessRow } from "@/actions/access-levels";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { claimsMoreThan, UNDER } from "@/lib/authz/level-order";
import { ACCESS_MODULES, actionRowsOf, sectionsOfModule, type ActionRowSpec } from "@/lib/staff/access-modules";
import { rowAllowed, type AccessFacts } from "@/lib/staff/access-explain";
import { moduleNote } from "@/lib/staff/permission-modules";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { Switch } from "@/components/settings/access/switch";
import { ModuleIcon } from "@/components/settings/access/module-icon";
import { ActionIcon } from "@/components/settings/access/action-icon";
import { PermissionPreview } from "@/components/settings/access/permission-preview";
import { FullViewButton, useFullView } from "@/components/ui/full-view";
import type { CatalogueEntry, ModuleStates } from "@/components/settings/staff/types";
import { cn } from "@/lib/utils";

export type RoleViewer = {
  mayManage: boolean;
  isSuperAdmin: boolean;
  /** The keys the viewer holds — the ones they may grant or take away. */
  holds: string[];
  role: string;
  /** Of the two keys that open these screens, the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
};

type Slot = `${string}:${string}`;
const slot = (record: string, action: string) => `${record}:${action}` as Slot;

/**
 * A role's Module Access tab: the modules on the left, the open module's actions — Allow, Record scope
 * and the conditions the server holds each to — and "Module enabled" for its place in the menu; the
 * Permission preview beside it follows every change.
 *
 * Each change is saved as it is made, through the actions that always saved roles
 * (`setRolePermissions`, `setRoleAccessLevels`) with every rule they apply; a refusal puts the box back
 * and says why.
 */
export function RoleModulesWorkspace({
  roleKey,
  catalogue,
  held,
  grid,
  gridWhy,
  selfExcluded,
  moduleStates,
  viewer,
  people,
  roleSummaryHref,
}: {
  roleKey: string;
  catalogue: CatalogueEntry[];
  held: string[];
  grid: AccessRow[];
  gridWhy: string | null;
  selfExcluded: string[];
  moduleStates: ModuleStates;
  viewer: RoleViewer;
  people: { id: string; name: string; roleName: string }[];
  roleSummaryHref: string;
}) {
  const router = useRouter();
  const [holds, setHolds] = useState<Set<string>>(() => new Set(held));
  const [stored, setStored] = useState<Map<Slot, AccessLevel | null>>(() => new Map());
  const [active, setActive] = useState(ACCESS_MODULES[0]!.key);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [saving, start] = useTransition();
  // The Modules box can fill the screen — its Actions table needs the width (src/components/ui/full-view.tsx).
  const fullView = useFullView();

  const byKey = useMemo(() => new Map(catalogue.map((c) => [c.key, c])), [catalogue]);
  const viewerHolds = useMemo(() => new Set(viewer.holds), [viewer.holds]);
  const excluded = useMemo(() => new Set(selfExcluded), [selfExcluded]);
  const savedHeld = useMemo(() => new Set(held), [held]);
  const records = grid.map((r) => ({ key: r.key, label: r.label, actions: r.actions }));

  const cellOf = (record: AccessRecord, action: AccessAction) => grid.find((r) => r.key === record)?.cells[action];
  const levelOf = (record: AccessRecord, action: AccessAction): AccessLevel => {
    const s = slot(record, action);
    const cell = cellOf(record, action);
    if (!cell) return "NONE";
    const picked = stored.has(s) ? stored.get(s)! : cell.stored;
    return picked ?? cell.derived;
  };
  const facts: AccessFacts = { holds: (k) => holds.has(k), level: levelOf };

  const keyLock = (key: string): string | null => {
    if (!viewer.mayManage) return "You can review roles but not change them.";
    if (roleKey === "ADMIN" && !viewer.isSuperAdmin) return "Only a super admin can change what admins can do.";
    if (viewer.isSuperAdmin) return null;
    if (byKey.get(key)?.superAdminOnly) return "Only a super admin can grant this permission.";
    if (!viewerHolds.has(key)) return "You don't hold this yourself, so you can't change it for a role.";
    if (roleKey === viewer.role && viewer.ownAccessThroughRole.includes(key) && savedHeld.has(key)) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };
  const levelLock = !viewer.mayManage ? "You can review roles but not change them." : gridWhy;

  /** Saves one change, as made; on a refusal the screen goes back to what is stored. */
  const apply = (permissions: { key: string; allowed: boolean }[], levels: AccessChange[], undo: () => void) =>
    start(async () => {
      setNotice(null);
      if (permissions.length) {
        const r = await setRolePermissions(roleKey, permissions);
        if (!r.ok) {
          undo();
          setNotice({ tone: "error", text: r.error });
          return;
        }
      }
      if (levels.length) {
        const r = await setRoleAccessLevels(roleKey, levels);
        if (!r.ok) {
          undo();
          setNotice({ tone: "error", text: r.error });
          router.refresh();
          return;
        }
      }
      router.refresh();
    });

  const setKeys = (changes: { key: string; allowed: boolean }[]) => {
    const before = new Set(holds);
    setHolds((prev) => {
      const next = new Set(prev);
      for (const c of changes) {
        if (c.allowed) next.add(c.key);
        else next.delete(c.key);
      }
      return next;
    });
    apply(changes, [], () => setHolds(before));
  };

  /** A record's level, with what sits under it narrowed so edit, delete and assign never reach wider than view. */
  const levelChanges = (record: AccessRecord, action: AccessAction, level: AccessLevel | null): AccessChange[] => {
    const row = grid.find((r) => r.key === record);
    if (!row) return [];
    const out: AccessChange[] = [{ record, action, level }];
    const effective = level ?? row.cells[action].derived;
    if (action === "view" || action === "edit") {
      for (const dependent of ["edit", "delete", "assign"] as const) {
        if (!row.actions.includes(dependent) || dependent === action) continue;
        if (!(UNDER[dependent] as readonly string[]).includes(action)) continue;
        if (claimsMoreThan(levelOf(record, dependent), effective)) out.push({ record, action: dependent, level: effective });
      }
    }
    return out;
  };
  const setLevels = (changes: AccessChange[], permissions: { key: string; allowed: boolean }[] = []) => {
    const beforeStored = new Map(stored);
    const beforeHolds = new Set(holds);
    setStored((prev) => {
      const next = new Map(prev);
      for (const c of changes) next.set(slot(c.record, c.action), c.level);
      return next;
    });
    if (permissions.length) {
      setHolds((prev) => {
        const next = new Set(prev);
        for (const c of permissions) {
          if (c.allowed) next.add(c.key);
          else next.delete(c.key);
        }
        return next;
      });
    }
    apply(permissions, changes, () => {
      setStored(beforeStored);
      setHolds(beforeHolds);
    });
  };

  const toggleRow = (row: ActionRowSpec, allow: boolean) => {
    if (row.kind === "key") return setKeys([{ key: row.key, allowed: allow }]);
    const cell = cellOf(row.record, row.action);
    if (!cell) return;
    const gridRow = grid.find((r) => r.key === row.record)!;
    if (allow) {
      // "View leads" is the permission that opens the leads at all, and the reach that comes with it.
      const permissions = row.viewKey && !holds.has(row.viewKey) ? [{ key: row.viewKey, allowed: true }] : [];
      const reaches = levelOf(row.record, row.action) !== "NONE";
      // Reaching something already, or nothing only for want of the permission: the permission alone.
      if (reaches || (permissions.length > 0 && cell.stored === null)) return permissions.length ? setKeys(permissions) : undefined;
      // A reach of nothing set here: back to what the role's permissions give, or — where they give
      // nothing — the narrowest reach there is.
      const permissionsGive = permissions.length > 0 || cell.derived !== "NONE";
      const narrowest = gridRow.levels.find((l) => l !== "NONE") ?? "OWN";
      const level: AccessLevel | null = cell.stored !== null && permissionsGive ? null : narrowest;
      return setLevels(levelChanges(row.record, row.action, level), permissions);
    }
    if (row.viewKey) return setKeys([{ key: row.viewKey, allowed: false }]);
    setLevels(levelChanges(row.record, row.action, "NONE"));
  };

  const current = ACCESS_MODULES.find((m) => m.key === active)!;
  const term = search.trim().toLowerCase();
  const shownModules = ACCESS_MODULES.filter((m) => !term || m.label.toLowerCase().includes(term) || m.description.toLowerCase().includes(term));
  const rows = actionRowsOf(active, records);
  const sections = sectionsOfModule(active);
  const moduleOn = sections.some((d) => holds.has(d.key));
  const sectionLock = sections.map((d) => keyLock(d.key)).find((w) => w !== null) ?? null;

  const conditionsOf = (row: ActionRowSpec): string[] => {
    if (row.kind === "record") return row.viewKey ? conditionsOf({ kind: "key", id: row.viewKey, label: row.label, key: row.viewKey }) : [];
    const entry = byKey.get(row.key);
    const out: string[] = [];
    if (excluded.has(row.key)) out.push("Never on their own records");
    if (entry?.superAdminOnly) out.push("Granted by a super admin only");
    if (entry?.tier === "critical") out.push("Critical");
    else if (entry?.tier === "sensitive") out.push("Sensitive");
    const note = entry ? moduleNote(entry.modules, moduleStates) : null;
    if (note) out.push(note);
    return out;
  };

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <Card className={cn("min-w-0", fullView.frameClass)}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-text">Modules</h3>
            <p className="mt-0.5 text-sm text-muted">Select which modules this role can access and configure permissions.</p>
          </div>
          {sections.length > 0 && (
            <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm text-text" title={sectionLock ?? undefined}>
              <Switch
                label={`${current.label} enabled for this role`}
                checked={moduleOn}
                disabled={saving || sectionLock !== null}
                onChange={(on) => setKeys(sections.map((d) => ({ key: d.key, allowed: on })))}
              />
              Module enabled
            </label>
          )}
          <FullViewButton full={fullView.full} toggle={fullView.toggle} />
        </div>

        <div className="@container">
          <div className="grid grid-cols-[minmax(0,1fr)] @lg:grid-cols-[12rem_minmax(0,1fr)]">
            <div className="min-w-0 border-b border-line p-3 @lg:border-b-0 @lg:border-r">
              <label className="relative block">
                <span className="sr-only">Search modules</span>
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search modules…" className="h-9 pl-8 text-sm" />
              </label>
              <ul aria-label="Modules" className="mt-2 flex gap-1 overflow-x-auto @lg:block @lg:space-y-0.5 @lg:overflow-visible">
                {shownModules.map((m) => (
                  <li key={m.key} className="shrink-0 @lg:shrink">
                    <button
                      type="button"
                      onClick={() => setActive(m.key)}
                      aria-current={active === m.key ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2.5 whitespace-nowrap rounded-base border-l-2 px-2 py-2 text-left transition-colors @lg:whitespace-normal",
                        active === m.key ? "border-brand bg-brand/10" : "border-transparent hover:bg-surface-sunken",
                      )}
                    >
                      <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-base", active === m.key ? "bg-brand/15 text-brand" : "bg-surface-sunken text-muted")}>
                        <ModuleIcon icon={m.icon} className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-text">{m.label}</span>
                        <span className="hidden text-xs leading-snug text-subtle @lg:line-clamp-2">{m.description}</span>
                      </span>
                      <ChevronRight className={cn("hidden h-4 w-4 shrink-0 @lg:block", active === m.key ? "text-brand" : "text-subtle")} aria-hidden />
                    </button>
                  </li>
                ))}
                {shownModules.length === 0 && <li className="px-2 py-4 text-sm text-subtle">No module matches.</li>}
              </ul>
            </div>

            <div className="@container min-w-0 space-y-4 p-4">
              <div className="flex items-start gap-3 border-b border-line pb-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-base bg-brand/10 text-brand">
                  <ModuleIcon icon={current.icon} className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <h4 className="text-base font-semibold text-text">{current.label}</h4>
                  <p className="text-sm text-muted">{current.description}</p>
                </div>
              </div>

              {sections.length > 0 && (
                <details className="group text-xs">
                  <summary className="cursor-pointer list-none text-subtle hover:text-text">
                    In the menu: {sections.filter((d) => holds.has(d.key)).length} of {sections.length} {sections.length === 1 ? "section" : "sections"}{" "}
                    <span className="text-brand group-open:hidden">· Choose</span>
                  </summary>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {sections.map((d) => {
                    const on = holds.has(d.key);
                    const why = keyLock(d.key);
                    return (
                      <label key={d.key} title={why ?? undefined} className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5", on ? "border-brand/30 bg-brand/5 text-text" : "border-line text-subtle")}>
                        <input
                          type="checkbox"
                          className="h-3 w-3 accent-[var(--color-brand)]"
                          checked={on}
                          disabled={saving || why !== null}
                          onChange={(e) => setKeys([{ key: d.key, allowed: e.target.checked }])}
                        />
                        {d.label.split(" › ").pop()}
                      </label>
                    );
                  })}
                  </div>
                </details>
              )}

              <div>
                <h5 className="text-sm font-semibold text-text">Actions</h5>
                <p className="text-xs text-muted">Control what this role can do in the {current.label} module.</p>
              </div>
              {levelLock && rows.some((r) => r.kind === "record") && (
                <p className="flex items-center gap-1.5 text-xs text-subtle">
                  <Lock className="h-3.5 w-3.5" aria-hidden />
                  {levelLock}
                </p>
              )}
              <div className="overflow-x-auto rounded-base border border-line">
                <table className="w-full min-w-[25rem] text-sm">
                  <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
                    <tr>
                      <th className="px-3 py-2">Action</th>
                      <th className="w-12 px-1 py-2 text-center">Allow</th>
                      <th className="w-[8.75rem] px-1 py-2">Record scope</th>
                      <th className="hidden px-3 py-2 @xl:table-cell">Conditions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const allowed = rowAllowed(row, facts);
                      const why = row.kind === "key" ? keyLock(row.key) : row.viewKey ? (keyLock(row.viewKey) ?? levelLock) : levelLock;
                      const conditions = conditionsOf(row);
                      return (
                        <tr key={row.id} className="border-b border-line align-middle last:border-0">
                          <td className="px-3 py-2">
                            <span className="flex items-center gap-2.5">
                              <ActionIcon row={row} className="h-4 w-4 shrink-0 text-muted" />
                              <span className="text-text">{row.label}</span>
                            </span>
                            {conditions.length > 0 && (
                              <span className="mt-1 flex flex-wrap gap-1 pl-[1.625rem] text-[11px] text-muted @xl:hidden">
                                {conditions.map((c) => (
                                  <span key={c} className="rounded-full bg-surface-sunken px-2 py-0.5">
                                    {c}
                                  </span>
                                ))}
                              </span>
                            )}
                          </td>
                          <td className="px-1 py-2 text-center">
                            <input
                              type="checkbox"
                              className="h-4 w-4 accent-[var(--color-brand)] disabled:opacity-50"
                              checked={allowed}
                              disabled={saving || why !== null}
                              title={why ?? undefined}
                              aria-label={`Allow ${row.label}`}
                              onChange={(e) => toggleRow(row, e.target.checked)}
                            />
                          </td>
                          <td className="px-1 py-2">
                            {row.kind === "record" ? (
                              <ScopeSelect
                                row={grid.find((g) => g.key === row.record)!}
                                action={row.action}
                                value={stored.has(slot(row.record, row.action)) ? stored.get(slot(row.record, row.action))! : cellOf(row.record, row.action)?.stored ?? null}
                                allowed={allowed}
                                disabled={saving || levelLock !== null || !allowed}
                                label={row.label}
                                onChange={(level) => setLevels(levelChanges(row.record, row.action, level))}
                              />
                            ) : (
                              <Select disabled className="h-8 w-full text-xs" aria-label={`${row.label}: record scope`} value="">
                                <option value="">{allowed ? "Not by record" : "None"}</option>
                              </Select>
                            )}
                          </td>
                          <td className="hidden px-3 py-2 text-xs text-muted @xl:table-cell">
                            {conditions.length ? (
                              <span className="flex flex-wrap gap-1">
                                {conditions.map((c) => (
                                  <span key={c} className="rounded-full bg-surface-sunken px-2 py-0.5">
                                    {c}
                                  </span>
                                ))}
                              </span>
                            ) : (
                              <span className="text-subtle">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={4} className="px-3 py-6 text-center text-subtle">
                          Nothing to allow in this module beyond its place in the menu.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
              <p className="text-xs text-subtle">{saving ? "Saving…" : "Changes are saved as you make them, and enforced on the server for every request."}</p>
            </div>
          </div>
        </div>
      </Card>

      <PermissionPreview
        records={records}
        roleFacts={{ holds: [...holds], levels: Object.fromEntries(grid.flatMap((r) => r.actions.map((a) => [slot(r.key, a), levelOf(r.key, a)]))) }}
        people={people}
        active={active}
        onSelect={setActive}
        roleSummaryHref={roleSummaryHref}
      />
    </div>
  );
}

/** A level as the Record scope column words it — short enough for the column. */
export const SCOPE_LABEL: Record<AccessLevel, string> = { NONE: "None", OWN: "Own", TEAM: "Team", BRANCH: "Branch", ALL: "All", FOLLOW: "Account" };

/**
 * A record's reach for one action. It shows what applies; choosing a level sets it on the role, and the
 * arrow beside a level set here puts it back to what the role's permissions give.
 */
function ScopeSelect({
  row,
  action,
  value,
  allowed,
  disabled,
  label,
  onChange,
}: {
  row: AccessRow;
  action: AccessAction;
  value: AccessLevel | null;
  allowed: boolean;
  disabled: boolean;
  label: string;
  onChange: (level: AccessLevel | null) => void;
}) {
  const derived = row.cells[action].derived;
  const effective = value ?? derived;
  const title = `Own: ${row.ownMeans}${value === null ? " · the role's default" : ""}`;
  if (!allowed) {
    return (
      <Select disabled className="h-8 w-full text-xs" aria-label={`${label}: record scope`} value="NONE">
        <option value="NONE">None</option>
      </Select>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <Select
        className="h-8 w-full min-w-0 text-xs"
        aria-label={`${label}: record scope`}
        title={title}
        value={effective}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as AccessLevel)}
      >
        {row.levels
          .filter((l) => l !== "NONE")
          .map((l) => (
            <option key={l} value={l}>
              {SCOPE_LABEL[l]}
            </option>
          ))}
      </Select>
      {value !== null && !disabled && (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={`${label}: back to the role's default (${SCOPE_LABEL[derived]})`}
          title={`Back to the role's default (${SCOPE_LABEL[derived]})`}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-base text-subtle hover:bg-surface-sunken hover:text-text"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}
