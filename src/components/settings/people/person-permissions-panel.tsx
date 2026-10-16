"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { AccessLevel } from "@prisma/client";
import { CalendarClock, Check, Info, Lock, MoreVertical, Plus, Search, X } from "lucide-react";
import { setPersonAccessLevels, setPersonPermissions, type PermissionState, type PersonLevelRow } from "@/actions/person-access";
import { setPersonFieldAccess, setPersonUnmaskLimit, type PersonFieldAccess } from "@/actions/field-access";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { ACCESS_MODULES, actionRowsOf, moduleOfPermission, sectionsOfModule, type ActionRowSpec } from "@/lib/staff/access-modules";
import { moduleStandingOf } from "@/lib/staff/access-explain";
import { getPermissionDefinition } from "@/lib/permissions";
import { maskValue, normalisePolicy, type FieldKind, type FieldPolicy, type MaskFormat } from "@/lib/authz/field-policy";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { Switch } from "@/components/settings/access/switch";
import { ModuleIcon } from "@/components/settings/access/module-icon";
import { ActionIcon } from "@/components/settings/access/action-icon";
import { useDraftEditor } from "@/components/settings/people/person-draft";
import { cn } from "@/lib/utils";

const SCOPE_LABEL: Record<AccessLevel, string> = { NONE: "None", OWN: "Own", TEAM: "Team", BRANCH: "Branch", ALL: "All", FOLLOW: "Account" };
/** A record scope said as a condition on what is allowed. */
const CONDITION_LABEL: Record<AccessLevel, string> = {
  NONE: "No records",
  OWN: "Only for own records",
  TEAM: "Only for their team's records",
  BRANCH: "Only for their branch's records",
  ALL: "All records",
  FOLLOW: "As their access to the account",
};
const SAMPLE: Record<FieldKind, string> = { text: "Acme Technologies", email: "sales@globex.com", phone: "+91 98765 43210", address: "12 MG Road, Pune", choice: "Website" };

/** One permission as a person's editors show it: their role's answer, their own (if any), and what applies. */
export type PersonPermissionRow = {
  key: string;
  label: string;
  description: string;
  tier: string;
  selfExcluded: boolean;
  /** Their role gives it. */
  role: boolean;
  /** Their own exception, if any: allow or deny, why and until when. */
  own: { allowed: boolean; reason: string | null; expiresAt: string | null; expired: boolean } | null;
  held: boolean;
  why: string;
};

type Slot = `${string}:${string}`;
const slot = (record: string, action: string) => `${record}:${action}` as Slot;
/** A row of the table, or of "Add custom permission": an action of a module, or one of its menu sections. */
type Row = ActionRowSpec & { moduleKey: string };

const STEPS = [
  { title: "Select the user", text: "Choose the user from the list whose permissions you want to customise." },
  { title: "Override permissions", text: "Allow or deny specific permissions. These override the role's settings." },
  { title: "Add custom permission", text: "Grant a permission the role doesn't give, or take one away." },
  { title: "Set conditions", text: "Limit what is allowed to their own, their team's or their branch's records, or until a date." },
  { title: "Save changes", text: "Save to apply these permissions for this user. Every change is in their Activity." },
];

/** The last day an exception applies, from the end-of-day instant it is stored as. */
const lastDay = (expiresAt: string) => new Date(new Date(expiresAt).getTime() - 1).toISOString().slice(0, 10);

/**
 * One person's Permissions tab — Individual Permissions: the modules; for the one open, each action with
 * their role's answer, an override for them alone (Use role default, Allow, Deny) and what applies to
 * them; every module's effective access beside it; permissions added for them alone, and the conditions
 * and end dates they carry; and, for CRM, their daily unmasking limit and which lead fields are masked.
 *
 * Nothing is saved here: every change waits for "Save changes" at the top of the page
 * (src/components/settings/people/person-draft.tsx), which saves each kind through its own action —
 * `setPersonPermissions` and `setPersonAccessLevels` here, in groups by end date — with every rule the
 * server applies. A condition is the person's record scope for that action (UserAccessLevel); an end
 * date is the exception's own.
 */
export function PersonPermissionsPanel({
  userId,
  name,
  roleName,
  permissions,
  grid,
  fields,
  canEdit,
  lockedWhy,
}: {
  userId: string;
  name: string;
  roleName: string;
  permissions: PersonPermissionRow[];
  grid: PersonLevelRow[];
  fields: PersonFieldAccess | null;
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const [active, setActive] = useState(ACCESS_MODULES[0]!.key);
  const [query, setQuery] = useState("");
  const byKey = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);
  const records = useMemo(() => grid.map((r) => ({ key: r.key, label: r.label, actions: r.actions })), [grid]);

  // ─── The draft: overrides, conditions and end dates not saved yet ──────────────────────────────
  const savedState = (p: PersonPermissionRow): PermissionState => (p.own && !p.own.expired ? (p.own.allowed ? "allow" : "deny") : "inherit");
  const [states, setStatesRaw] = useState<Map<string, PermissionState>>(() => new Map());
  const [levels, setLevelsRaw] = useState<Map<Slot, AccessLevel | null>>(() => new Map());
  /** An end date for one change (by key or slot), and one for every change in a module. */
  const [expiry, setExpiryRaw] = useState<Map<string, string>>(() => new Map());
  const [moduleExpiry, setModuleExpiryRaw] = useState<Map<string, string>>(() => new Map());
  /**
   * Saved, and waiting for the page to bring the saved answers back (it remounts this when they change):
   * what was chosen stays on screen meanwhile, with nothing left to save. Any new change starts a draft again.
   */
  const [committed, setCommitted] = useState(false);
  const setStates: typeof setStatesRaw = (v) => {
    setCommitted(false);
    setStatesRaw(v);
  };
  const setLevels: typeof setLevelsRaw = (v) => {
    setCommitted(false);
    setLevelsRaw(v);
  };
  const setExpiry: typeof setExpiryRaw = (v) => {
    setCommitted(false);
    setExpiryRaw(v);
  };
  const setModuleExpiry: typeof setModuleExpiryRaw = (v) => {
    setCommitted(false);
    setModuleExpiryRaw(v);
  };

  const cellOf = (record: AccessRecord, action: AccessAction) => grid.find((r) => r.key === record)?.cells[action];
  const gridRowOf = (record: AccessRecord) => grid.find((r) => r.key === record);
  const stateOf = (key: string): PermissionState => {
    const p = byKey.get(key);
    return states.get(key) ?? (p ? savedState(p) : "inherit");
  };
  const holdsAfter = (key: string): boolean => {
    const p = byKey.get(key);
    if (!p) return false;
    if (!states.has(key)) return p.held;
    const s = states.get(key)!;
    return s === "inherit" ? p.role : s === "allow";
  };
  const ownLevel = (record: AccessRecord, action: AccessAction): AccessLevel | null => {
    const s = slot(record, action);
    return levels.has(s) ? levels.get(s)! : (cellOf(record, action)?.own?.level ?? null);
  };
  const levelAfter = (record: AccessRecord, action: AccessAction): AccessLevel => {
    const cell = cellOf(record, action);
    if (!cell) return "NONE";
    const s = slot(record, action);
    if (!levels.has(s)) return cell.effective;
    return levels.get(s) ?? cell.role;
  };

  const moduleOfKey = (key: string) => ACCESS_MODULES.find((m) => m.sections.includes(key))?.key ?? (getPermissionDefinition(key) ? moduleOfPermission(getPermissionDefinition(key)!) : "admin");
  const moduleOfRecord = (record: string) => ACCESS_MODULES.find((m) => (m.records as readonly string[]).includes(record))?.key ?? "admin";
  const endOf = (id: string, moduleKey: string) => expiry.get(id) ?? moduleExpiry.get(moduleKey) ?? null;

  // A change is a different answer — or the same exception given a new end date.
  const permissionChanges = [...states].filter(([key, s]) => {
    const p = byKey.get(key);
    if (!p) return false;
    return savedState(p) !== s || (s !== "inherit" && endOf(key, moduleOfKey(key)) !== null);
  });
  const levelChanges = [...levels].filter(([s, level]) => {
    const [record, action] = s.split(":") as [AccessRecord, AccessAction];
    return (cellOf(record, action)?.own?.level ?? null) !== level || (level !== null && endOf(s, moduleOfRecord(record)) !== null);
  });
  const count = committed ? 0 : permissionChanges.length + levelChanges.length;
  const clear = () => {
    setCommitted(false);
    setStatesRaw(new Map());
    setLevelsRaw(new Map());
    setExpiryRaw(new Map());
    setModuleExpiryRaw(new Map());
  };

  useDraftEditor("actions", count, {
    label: "permissions",
    save: async (options) => {
      // One call per end date: each change keeps its own, or its module's, or the one asked for on save.
      const byEnd = <T,>(items: [string, T][], moduleOf: (id: string) => string) => {
        const groups = new Map<string, [string, T][]>();
        for (const item of items) {
          const end = endOf(item[0], moduleOf(item[0])) ?? options.expiresAt ?? "";
          groups.set(end, [...(groups.get(end) ?? []), item]);
        }
        return groups;
      };
      for (const [end, items] of byEnd(permissionChanges, moduleOfKey)) {
        const r = await setPersonPermissions(userId, items.map(([key, state]) => ({ key, state })), { reason: options.reason, expiresAt: end || null });
        if (!r.ok) return r.error;
      }
      for (const [end, items] of byEnd(levelChanges, (s) => moduleOfRecord(s.split(":")[0]!))) {
        const r = await setPersonAccessLevels(
          userId,
          items.map(([s, level]) => {
            const [record, action] = s.split(":");
            return { record: record!, action: action!, level };
          }),
          { reason: options.reason, expiresAt: end || null },
        );
        if (!r.ok) return permissionChanges.length ? `The permissions were saved, but not every condition: ${r.error}` : r.error;
      }
      setCommitted(true);
      return null;
    },
    discard: clear,
  });

  // ─── Rows ───────────────────────────────────────────────────────────────────────────────────
  const rowsOf = (moduleKey: string): Row[] => actionRowsOf(moduleKey, records).map((r) => ({ ...r, moduleKey }));
  /** Everything "Add custom permission" offers in a module: its actions, then its place in the menu. */
  const customRowsOf = (moduleKey: string): Row[] => [
    ...rowsOf(moduleKey),
    ...sectionsOfModule(moduleKey).map((d): Row => ({ kind: "key", id: d.key, label: `Menu: ${d.label}`, key: d.key, moduleKey })),
  ];
  const allRows = useMemo(() => ACCESS_MODULES.flatMap((m) => [...actionRowsOf(m.key, records).map((r) => ({ ...r, moduleKey: m.key })), ...sectionsOfModule(m.key).map((d): Row => ({ kind: "key", id: d.key, label: `Menu: ${d.label}`, key: d.key, moduleKey: m.key }))]), [records]);
  const rowOfKey = (key: string) => allRows.find((r) => (r.kind === "key" ? r.key === key : r.viewKey === key));
  const rowOfSlot = (s: string) => allRows.find((r) => r.kind === "record" && r.id === s);

  const q = query.trim().toLowerCase();
  const shown: Row[] = q ? ACCESS_MODULES.flatMap((m) => rowsOf(m.key)).filter((r) => r.label.toLowerCase().includes(q)) : rowsOf(active);

  const roleAllows = (row: Row): boolean => {
    if (row.kind === "key") return Boolean(byKey.get(row.key)?.role);
    const roleLevel = cellOf(row.record, row.action)?.role ?? "NONE";
    return (row.viewKey ? Boolean(byKey.get(row.viewKey)?.role) : true) && roleLevel !== "NONE";
  };
  const overrideOf = (row: Row): PermissionState => {
    if (row.kind === "key") return stateOf(row.key);
    if (row.viewKey) return stateOf(row.viewKey);
    const own = ownLevel(row.record, row.action);
    return own === null ? "inherit" : own === "NONE" ? "deny" : "allow";
  };
  const allowedAfter = (row: Row): boolean => {
    if (row.kind === "key") return holdsAfter(row.key);
    if (row.viewKey && !holdsAfter(row.viewKey)) return false;
    return levelAfter(row.record, row.action) !== "NONE";
  };
  const setOverride = (row: Row, value: PermissionState) => {
    if (row.kind === "key" || row.viewKey) {
      const key = row.kind === "key" ? row.key : row.viewKey!;
      setStates((prev) => new Map(prev).set(key, value));
      return;
    }
    const cell = cellOf(row.record, row.action);
    const gridRow = gridRowOf(row.record);
    if (!cell || !gridRow) return;
    const level: AccessLevel | null =
      value === "inherit" ? null : value === "deny" ? "NONE" : cell.role !== "NONE" ? cell.role : (gridRow.levels.find((l) => l !== "NONE") ?? "OWN");
    setLevels((prev) => new Map(prev).set(slot(row.record, row.action), level));
  };
  /** A condition: their own record scope for this action — and, where a permission opens it, that allowed too. */
  const setCondition = (row: Row, level: AccessLevel | null) => {
    if (row.kind !== "record") return;
    setLevels((prev) => new Map(prev).set(slot(row.record, row.action), level));
    if (level && level !== "NONE" && row.viewKey && !holdsAfter(row.viewKey)) setStates((prev) => new Map(prev).set(row.viewKey!, "allow"));
  };
  const facts = { holds: holdsAfter, level: levelAfter };

  // ─── What is set for them alone ─────────────────────────────────────────────────────────────
  const moduleLabel = (key: string) => ACCESS_MODULES.find((m) => m.key === key)?.label ?? "Settings";
  const overrides = [
    ...permissions.flatMap((p) => {
      const s = stateOf(p.key);
      if (s === "inherit") return [];
      const row = rowOfKey(p.key);
      const end = endOf(p.key, moduleOfKey(p.key)) ?? (p.own && !p.own.expired && savedState(p) === s ? (p.own.expiresAt ? lastDay(p.own.expiresAt) : null) : null);
      return [{ id: p.key, module: moduleOfKey(p.key), label: row?.label ?? p.label, allowed: s === "allow", condition: null as string | null, end, reason: p.own?.reason ?? null, pending: !committed && states.has(p.key) && savedState(p) !== s, remove: () => setStates((prev) => new Map(prev).set(p.key, "inherit")) }];
    }),
    ...grid.flatMap((g) =>
      g.actions.flatMap((action) => {
        const own = ownLevel(g.key, action);
        if (own === null) return [];
        const s = slot(g.key, action);
        const row = rowOfSlot(s);
        const saved = g.cells[action].own;
        const end = endOf(s, moduleOfRecord(g.key)) ?? (saved && saved.level === own && saved.expiresAt ? lastDay(saved.expiresAt) : null);
        return [{ id: s, module: moduleOfRecord(g.key), label: row?.label ?? `${action} ${g.label}`, allowed: own !== "NONE", condition: own === "NONE" ? null : CONDITION_LABEL[own], end, reason: saved?.reason ?? null, pending: !committed && levels.has(s) && (saved?.level ?? null) !== own, remove: () => setLevels((prev) => new Map(prev).set(s, null)) }];
      }),
    ),
  ];
  const customModules = new Set(overrides.map((o) => o.module));

  const current = ACCESS_MODULES.find((m) => m.key === active)!;
  const [dialog, setDialog] = useState<null | "custom" | "condition" | "expiry">(null);

  return (
    <div className="space-y-5">
      <Card className="@container min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5">
          <div className="min-w-0">
            <h3 className="text-lg font-semibold text-text">Individual Permissions</h3>
            <p className="mt-0.5 text-sm text-muted">Override or extend permissions for this user. These settings take priority over role permissions.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative block w-64 max-w-full">
              <span className="sr-only">Search permissions</span>
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search permissions…" className="h-9 pl-8 text-sm" />
            </label>
            <Select
              aria-label="Bulk actions"
              value=""
              disabled={!canEdit || shown.length === 0}
              onChange={(e) => {
                const value = e.target.value as PermissionState | "";
                if (value) for (const row of shown) setOverride(row, value);
              }}
              className="h-9 w-40 text-sm"
            >
              <option value="">Bulk actions</option>
              <option value="inherit">Use role default for all shown</option>
              <option value="allow">Allow all shown</option>
              <option value="deny">Deny all shown</option>
            </Select>
          </div>
        </div>
        <p className="mx-5 mt-4 flex items-start gap-2 rounded-base border border-info/20 bg-info-bg px-3 py-2 text-[13px] text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Permissions set here will override the user&apos;s role permissions. Leave them on &ldquo;Use role default&rdquo; to follow the role.
        </p>
        {lockedWhy && (
          <p className="mx-5 mt-2 flex items-center gap-1.5 text-xs text-subtle">
            <Lock className="h-3.5 w-3.5" aria-hidden />
            {lockedWhy}
          </p>
        )}

        <div className="mt-4 grid grid-cols-1 border-t border-line @3xl:grid-cols-[13rem_minmax(0,1fr)] @[76rem]:grid-cols-[13rem_minmax(0,1fr)_17.5rem]">
          {/* Modules */}
          <nav aria-label="Modules" className="min-w-0 border-b border-line p-3 @3xl:border-b-0 @3xl:border-r">
            <h4 className="px-2 pb-2 text-sm font-semibold text-text">Modules</h4>
            <ul className="flex gap-1 overflow-x-auto @3xl:block @3xl:space-y-0.5 @3xl:overflow-visible">
              {ACCESS_MODULES.map((m) => {
                const on = !q && active === m.key;
                return (
                  <li key={m.key} className="shrink-0 @3xl:shrink">
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setActive(m.key);
                      }}
                      aria-current={on ? "true" : undefined}
                      className={cn(
                        "flex w-full items-start gap-2.5 whitespace-nowrap rounded-base border-l-2 px-2 py-2 text-left transition-colors @3xl:whitespace-normal",
                        on ? "border-brand bg-brand/10" : "border-transparent hover:bg-surface-sunken",
                      )}
                    >
                      <ModuleIcon icon={m.icon} className={cn("mt-0.5 h-4 w-4 shrink-0", on ? "text-brand" : "text-muted")} />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text">{m.label}</span>
                        <span className="hidden text-[11px] leading-snug text-subtle @3xl:line-clamp-2">{m.description}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* The module's permissions */}
          <div className="min-w-0 p-4">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-base bg-brand/10 text-brand">
                {q ? <Search className="h-5 w-5" aria-hidden /> : <ModuleIcon icon={current.icon} className="h-5 w-5" />}
              </span>
              <div className="min-w-0">
                <h4 className="text-base font-semibold text-text">{q ? `Permissions matching “${query.trim()}”` : current.label}</h4>
                <p className="text-xs text-muted">{q ? `${shown.length} across every module` : current.description}</p>
              </div>
            </div>
            <div className="mt-4 overflow-x-auto rounded-base border border-line">
              <table className="w-full min-w-[36rem] text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
                  <tr>
                    <th className="px-3 py-2">Permission</th>
                    <th className="w-[7.5rem] px-2 py-2">Role default ({roleName})</th>
                    <th className="w-[10.5rem] px-2 py-2">Individual override</th>
                    <th className="w-[8.5rem] px-2 py-2">Effective for {name.split(" ")[0]}</th>
                    <th className="w-9 py-2">
                      <span className="sr-only">More</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => {
                    const value = overrideOf(row);
                    const allowed = allowedAfter(row);
                    const level = row.kind === "record" ? levelAfter(row.record, row.action) : null;
                    return (
                      <tr key={`${row.moduleKey}:${row.id}`} className="border-b border-line last:border-0">
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-2.5">
                            <ActionIcon row={row} className="h-4 w-4 shrink-0 text-muted" />
                            <span className="min-w-0">
                              <span className="block text-text">{row.label}</span>
                              {q && <span className="block text-[11px] text-subtle">{moduleLabel(row.moduleKey)}</span>}
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <YesNo yes={roleAllows(row)} boxed />
                        </td>
                        <td className="px-2 py-2">
                          <Select
                            aria-label={`${row.label}: individual override`}
                            value={value}
                            disabled={!canEdit}
                            onChange={(e) => setOverride(row, e.target.value as PermissionState)}
                            className={cn(
                              "h-8 w-full text-xs",
                              value === "allow" && "border-success/50 bg-success-bg text-success",
                              value === "deny" && "border-danger/50 bg-danger-bg text-danger",
                            )}
                          >
                            <option value="inherit">Use role default</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </Select>
                        </td>
                        <td className="whitespace-nowrap px-2 py-2" title={allowed && level ? CONDITION_LABEL[level] : undefined}>
                          <YesNo yes={allowed} />
                          {allowed && level && level !== "ALL" && <span className="text-[11px] text-subtle"> · {SCOPE_LABEL[level]}</span>}
                        </td>
                        <td className="py-2 pr-1">
                          <RowMenu
                            row={row}
                            canEdit={canEdit}
                            why={row.kind === "key" ? byKey.get(row.key)?.why : row.viewKey && !holdsAfter(row.viewKey) ? byKey.get(row.viewKey)?.why : cellOf(row.record, row.action)?.why}
                            scope={
                              row.kind === "record" && gridRowOf(row.record)
                                ? { value: ownLevel(row.record, row.action), role: cellOf(row.record, row.action)?.role ?? "NONE", levels: gridRowOf(row.record)!.levels, ownMeans: gridRowOf(row.record)!.ownMeans }
                                : null
                            }
                            end={expiry.get(row.kind === "key" ? row.key : (row.viewKey ?? row.id)) ?? ""}
                            onScope={(level) => setCondition(row, level)}
                            onEnd={(date) =>
                              setExpiry((prev) => {
                                const next = new Map(prev);
                                for (const id of [row.kind === "key" ? row.key : row.viewKey, row.kind === "record" ? row.id : null]) {
                                  if (!id) continue;
                                  if (date) next.set(id, date);
                                  else next.delete(id);
                                }
                                return next;
                              })
                            }
                            onReset={() => {
                              setOverride(row, "inherit");
                              if (row.kind === "record") setLevels((prev) => new Map(prev).set(slot(row.record, row.action), null));
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                  {shown.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-6 text-center text-subtle">
                        {q ? "No permission matches." : "Nothing to grant in this module beyond its place in the menu — add that with “Add custom permission”."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Effective access, as it will be once saved */}
          <aside className="min-w-0 border-t border-line p-4 @3xl:col-span-2 @[76rem]:col-span-1 @[76rem]:border-l @[76rem]:border-t-0">
            <h4 className="text-sm font-semibold text-text">Effective Access for {name}</h4>
            <ul className="mt-3 grid gap-1 @3xl:grid-cols-2 @[76rem]:grid-cols-1">
              {ACCESS_MODULES.map((m) => {
                const standing = moduleStandingOf(m.key, facts);
                const badge = customModules.has(m.key)
                  ? { tone: "brand" as const, text: "Custom permissions" }
                  : standing === "full"
                    ? { tone: "green" as const, text: "Full access" }
                    : standing === "limited"
                      ? { tone: "amber" as const, text: "Partial access" }
                      : { tone: "red" as const, text: "No access" };
                return (
                  <li key={m.key}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setActive(m.key);
                      }}
                      className={cn("flex w-full items-center gap-2.5 rounded-base px-2 py-1.5 text-left text-sm transition-colors", !q && active === m.key ? "bg-brand/10" : "hover:bg-surface-sunken")}
                    >
                      <ModuleIcon icon={m.icon} className="h-4 w-4 shrink-0 text-muted" />
                      <span className="min-w-0 flex-1 truncate text-text">{m.label}</span>
                      <Badge tone={badge.tone}>{badge.text}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text">Additional user-specific permissions</h3>
          <p className="mt-0.5 text-xs text-muted">Grant extra permissions not available in the role, or restrict specific actions.</p>
          {overrides.length > 0 && (
            <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto pr-1">
              {overrides.map((o) => (
                <li key={o.id} className="flex items-start gap-2 rounded-base border border-line px-2.5 py-1.5 text-[13px]">
                  <YesNo yes={o.allowed} label={o.allowed ? "Allow" : "Deny"} />
                  <span className="min-w-0 flex-1">
                    <span className="text-text">{o.label}</span>
                    <span className="text-subtle"> · {moduleLabel(o.module)}</span>
                    {(o.condition || o.end || o.reason || o.pending) && (
                      <span className="block text-[11px] text-subtle">
                        {[o.condition, o.end ? `until ${o.end}` : null, o.reason ? `“${o.reason}”` : null, o.pending ? "after you save" : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </span>
                  {canEdit && (
                    <button type="button" onClick={o.remove} aria-label={`Back to the role's default: ${o.label}`} title="Back to the role's default" className="rounded-base p-0.5 text-subtle hover:bg-surface-sunken hover:text-text">
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Button variant="secondary" size="sm" className="mt-3" disabled={!canEdit} onClick={() => setDialog("custom")}>
            <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Add custom permission
          </Button>
        </Card>
        <Card className="p-5">
          <h3 className="text-sm font-semibold text-text">Conditions (optional)</h3>
          <p className="mt-0.5 text-xs text-muted">Apply conditions to these permissions: which of the records they cover, and until when.</p>
          {(() => {
            const here = overrides.filter((o) => o.module === active && (o.condition || o.end));
            const moduleEnd = moduleExpiry.get(active);
            return here.length > 0 || moduleEnd ? (
              <ul className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
                {moduleEnd && (
                  <li className="inline-flex items-center gap-1 rounded-full border border-brand/30 bg-brand/5 px-2 py-0.5 text-text">
                    <CalendarClock className="h-3 w-3" aria-hidden />
                    Changes in {current.label} end {moduleEnd}
                    <button type="button" aria-label="No end date for this module" onClick={() => setModuleExpiry((prev) => { const next = new Map(prev); next.delete(active); return next; })}>
                      <X className="h-3 w-3" aria-hidden />
                    </button>
                  </li>
                )}
                {here.map((o) => (
                  <li key={o.id} className="rounded-full border border-line px-2 py-0.5 text-muted">
                    {o.label}: {[o.condition, o.end ? `until ${o.end}` : null].filter(Boolean).join(", ")}
                  </li>
                ))}
              </ul>
            ) : null;
          })()}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={!canEdit || !rowsOf(active).some((r) => r.kind === "record")} onClick={() => setDialog("condition")}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Add condition
            </Button>
            <Button variant="secondary" size="sm" disabled={!canEdit} onClick={() => setDialog("expiry")}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Set expiry
            </Button>
          </div>
        </Card>
      </div>

      {fields && (
        // Kept mounted on every module, so what was changed here waits for "Save changes" while another is open.
        <div className={cn("grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]", active !== "crm" || q ? "hidden" : undefined)}>
          <UnmaskLimitPanel key={`limit:${userId}`} userId={userId} name={name} data={fields} canEdit={canEdit && fields.editable} />
          <FieldMaskingPanel key={`fields:${userId}`} userId={userId} name={name} data={fields} canEdit={canEdit && fields.editable} />
        </div>
      )}

      <Card className="border-info/20 bg-info-bg/40 p-5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-text">
          <Info className="h-4 w-4 text-info" aria-hidden />
          How it works?
        </h3>
        <ol className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-2.5">
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand text-[11px] font-semibold text-brand-contrast">{i + 1}</span>
              <span>
                <span className="block text-[13px] font-medium text-text">{s.title}</span>
                <span className="block text-xs text-muted">{s.text}</span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      {dialog === "custom" && (
        <CustomPermissionDialog
          initialModule={active}
          rowsOf={customRowsOf}
          gridRowOf={gridRowOf}
          onClose={() => setDialog(null)}
          onAdd={({ row, allow, condition, end }) => {
            setOverride(row, allow ? "allow" : "deny");
            if (allow && condition) setCondition(row, condition);
            if (end) {
              setExpiry((prev) => {
                const next = new Map(prev);
                if (row.kind === "key") next.set(row.key, end);
                else {
                  if (row.viewKey) next.set(row.viewKey, end);
                  next.set(row.id, end);
                }
                return next;
              });
            }
            setQuery("");
            setActive(row.moduleKey);
            setDialog(null);
          }}
        />
      )}
      {dialog === "condition" && (
        <ConditionDialog
          moduleLabel={current.label}
          rows={rowsOf(active).filter((r) => r.kind === "record")}
          gridRowOf={gridRowOf}
          onClose={() => setDialog(null)}
          onApply={(row, level) => {
            setCondition(row, level);
            setDialog(null);
          }}
        />
      )}
      {dialog === "expiry" && (
        <Dialog open onClose={() => setDialog(null)} title={`Set an end date — ${current.label}`}>
          <ExpiryForm
            initial={moduleExpiry.get(active) ?? ""}
            note={`Every change made for ${name} in ${current.label} ends on this day, unless it has a date of its own. After it, they follow their role again.`}
            onCancel={() => setDialog(null)}
            onApply={(date) => {
              setModuleExpiry((prev) => {
                const next = new Map(prev);
                if (date) next.set(active, date);
                else next.delete(active);
                return next;
              });
              setDialog(null);
            }}
          />
        </Dialog>
      )}
    </div>
  );
}

/** Allowed or Denied, as a tick or a cross — boxed for the role's answer, plain for what applies. */
function YesNo({ yes, boxed = false, label }: { yes: boolean; boxed?: boolean; label?: string }) {
  const Icon = yes ? Check : X;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", yes ? "text-success" : "text-danger")}>
      <span className={cn("grid h-4 w-4 shrink-0 place-items-center", boxed ? "rounded-[3px]" : "rounded-full", yes ? "bg-success text-white" : "bg-danger text-white")}>
        <Icon className="h-3 w-3" strokeWidth={3} aria-hidden />
      </span>
      {label ?? (yes ? "Allowed" : "Denied")}
    </span>
  );
}

/** The ⋮ on a row: why it is what it is, its record scope, an end date for the change, and back to the role. */
function RowMenu({
  row,
  canEdit,
  why,
  scope,
  end,
  onScope,
  onEnd,
  onReset,
}: {
  row: Row;
  canEdit: boolean;
  why: string | undefined;
  scope: { value: AccessLevel | null; role: AccessLevel; levels: AccessLevel[]; ownMeans: string } | null;
  end: string;
  onScope: (level: AccessLevel | null) => void;
  onEnd: (date: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`More for ${row.label}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="grid h-7 w-7 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text"
      >
        <MoreVertical className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label={row.label} className="absolute right-0 top-8 z-20 w-72 space-y-3 rounded-base border border-line bg-surface p-3 text-left text-xs shadow-lg">
          {why && <p className="text-muted">{why}</p>}
          {scope && (
            <div className="space-y-1">
              <Label htmlFor={`scope-${row.id}`} className="text-xs">
                Record scope
              </Label>
              <Select id={`scope-${row.id}`} value={scope.value ?? ""} disabled={!canEdit} onChange={(e) => onScope(e.target.value === "" ? null : (e.target.value as AccessLevel))} className="h-8 w-full text-xs">
                <option value="">Role default ({SCOPE_LABEL[scope.role]})</option>
                {scope.levels.map((l) => (
                  <option key={l} value={l}>
                    {CONDITION_LABEL[l]}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-subtle">Own: {scope.ownMeans}.</p>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor={`end-${row.id}`} className="text-xs">
              Override ends (optional)
            </Label>
            <Input id={`end-${row.id}`} type="date" value={end} disabled={!canEdit} onChange={(e) => onEnd(e.target.value)} className="h-8 text-xs" />
          </div>
          {canEdit && (
            <button
              type="button"
              className="text-brand hover:underline"
              onClick={() => {
                onReset();
                setOpen(false);
              }}
            >
              Back to the role&apos;s default
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Add custom permission": a module, one of its permissions, Allow or Deny, a condition and an end date. */
function CustomPermissionDialog({
  initialModule,
  rowsOf,
  gridRowOf,
  onClose,
  onAdd,
}: {
  initialModule: string;
  rowsOf: (moduleKey: string) => Row[];
  gridRowOf: (record: AccessRecord) => PersonLevelRow | undefined;
  onClose: () => void;
  onAdd: (choice: { row: Row; allow: boolean; condition: AccessLevel | null; end: string }) => void;
}) {
  const [moduleKey, setModuleKey] = useState(initialModule);
  const rows = rowsOf(moduleKey);
  const [rowId, setRowId] = useState(rows[0]?.id ?? "");
  const [allow, setAllow] = useState(true);
  const [condition, setConditionChoice] = useState<AccessLevel | "">("");
  const [end, setEnd] = useState("");
  const row = rows.find((r) => r.id === rowId) ?? rows[0];
  const levels = row?.kind === "record" ? (gridRowOf(row.record)?.levels ?? []).filter((l) => l !== "NONE") : [];
  return (
    <Dialog open onClose={onClose} title="Add custom permission">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="cp-module">Module</Label>
            <Select
              id="cp-module"
              value={moduleKey}
              onChange={(e) => {
                setModuleKey(e.target.value);
                setRowId(rowsOf(e.target.value)[0]?.id ?? "");
                setConditionChoice("");
              }}
            >
              {ACCESS_MODULES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="cp-permission">Permission</Label>
            <Select
              id="cp-permission"
              value={row?.id ?? ""}
              onChange={(e) => {
                setRowId(e.target.value);
                setConditionChoice("");
              }}
            >
              {rows.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <fieldset className="space-y-1">
          <legend className="text-[13px] font-medium text-muted">Access</legend>
          <div className="flex gap-5 text-sm text-text">
            <label className="flex items-center gap-2">
              <input type="radio" name="cp-access" checked={allow} onChange={() => setAllow(true)} className="h-4 w-4 accent-[var(--color-brand)]" />
              Allow
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="cp-access" checked={!allow} onChange={() => setAllow(false)} className="h-4 w-4 accent-[var(--color-brand)]" />
              Deny
            </label>
          </div>
        </fieldset>
        <div className="space-y-1">
          <Label htmlFor="cp-condition">Condition (optional)</Label>
          <Select id="cp-condition" value={condition} disabled={!allow || levels.length === 0} onChange={(e) => setConditionChoice(e.target.value as AccessLevel | "")}>
            <option value="">{levels.length === 0 ? "None — not a matter of which records" : "No condition — the role's record scope"}</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {CONDITION_LABEL[l]}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cp-end">Expiry (optional)</Label>
          <Input id="cp-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-48" />
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!row} onClick={() => row && onAdd({ row, allow, condition: condition || null, end })}>
            Add permission
          </Button>
        </div>
        <p className="text-[11px] text-subtle">It is saved with the rest by &ldquo;Save changes&rdquo; at the top.</p>
      </div>
    </Dialog>
  );
}

/** "Add condition": which of the records one of the module's actions covers, for this person. */
function ConditionDialog({
  moduleLabel,
  rows,
  gridRowOf,
  onClose,
  onApply,
}: {
  moduleLabel: string;
  rows: Row[];
  gridRowOf: (record: AccessRecord) => PersonLevelRow | undefined;
  onClose: () => void;
  onApply: (row: Row, level: AccessLevel | null) => void;
}) {
  const [rowId, setRowId] = useState(rows[0]?.id ?? "");
  const row = rows.find((r) => r.id === rowId) ?? rows[0];
  const levels = row?.kind === "record" ? (gridRowOf(row.record)?.levels ?? []).filter((l) => l !== "NONE") : [];
  const [level, setLevel] = useState<AccessLevel | "">("");
  return (
    <Dialog open onClose={onClose} title={`Add condition — ${moduleLabel}`}>
      <div className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor="cd-action">Permission</Label>
          <Select
            id="cd-action"
            value={row?.id ?? ""}
            onChange={(e) => {
              setRowId(e.target.value);
              setLevel("");
            }}
          >
            {rows.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cd-level">Condition</Label>
          <Select id="cd-level" value={level} onChange={(e) => setLevel(e.target.value as AccessLevel | "")}>
            <option value="">The role&apos;s record scope (no condition)</option>
            {levels.map((l) => (
              <option key={l} value={l}>
                {CONDITION_LABEL[l]}
              </option>
            ))}
          </Select>
          {row?.kind === "record" && <p className="text-[11px] text-subtle">Own: {gridRowOf(row.record)?.ownMeans}.</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!row} onClick={() => row && onApply(row, level || null)}>
            Apply condition
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ExpiryForm({ initial, note, onCancel, onApply }: { initial: string; note: string; onCancel: () => void; onApply: (date: string) => void }) {
  const [date, setDate] = useState(initial);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{note}</p>
      <div className="space-y-1">
        <Label htmlFor="module-end">Ends on</Label>
        <Input id="module-end" type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-48" />
      </div>
      <div className="flex justify-end gap-2 border-t border-line pt-3">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => onApply(date)}>
          {date ? "Set expiry" : "No end date"}
        </Button>
      </div>
    </div>
  );
}

// ─── Unmasking limits (daily) ─────────────────────────────────────────────────────────────────────

export function UnmaskLimitPanel({ userId, name, data, canEdit }: { userId: string; name: string; data: PersonFieldAccess; canEdit: boolean }) {
  const saved = data.limit.own;
  const [own, setOwnRaw] = useState<{ limited: boolean; dailyLimit: number | null } | null>(saved ? { limited: saved.limited, dailyLimit: saved.dailyLimit } : null);
  // Saved and waiting for the page to bring it back, as the actions above.
  const [committed, setCommitted] = useState(false);
  const setOwn = (next: { limited: boolean; dailyLimit: number | null } | null) => {
    setCommitted(false);
    setOwnRaw(next);
  };
  const limited = own ? own.limited : data.limit.role !== null;
  const value = own ? own.dailyLimit : data.limit.role;
  const dirty = !committed && JSON.stringify(own) !== JSON.stringify(saved ? { limited: saved.limited, dailyLimit: saved.dailyLimit } : null);

  useDraftEditor("limit", dirty ? 1 : 0, {
    label: "daily limit",
    save: async (options) => {
      const r = await setPersonUnmaskLimit(userId, own ? { limited: own.limited, dailyLimit: own.dailyLimit ?? undefined } : null, options);
      if (!r.ok) return r.error;
      setCommitted(true);
      return null;
    },
    discard: () => setOwn(saved ? { limited: saved.limited, dailyLimit: saved.dailyLimit } : null),
  });

  return (
    <Card className="@container border-brand/30 p-4">
      <h3 className="text-sm font-semibold text-text">Unmasking limits (Daily)</h3>
      <p className="mt-0.5 text-xs text-muted">Control how many leads {name} can unmask per day.</p>
      <label className="mt-3 flex items-center gap-2.5 text-sm text-text">
        <Switch
          label="Enable daily unmasking limit"
          checked={limited}
          disabled={!canEdit}
          onChange={(on) => setOwn({ limited: on, dailyLimit: on ? (value ?? 50) : null })}
        />
        Enable daily unmasking limit
      </label>
      <div className="mt-3 grid gap-4 @md:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor="limit-total" className="text-xs text-muted">
            Total unmasking allowed per day
          </label>
          <Input
            id="limit-total"
            inputMode="numeric"
            value={limited && value !== null ? String(value) : ""}
            placeholder={limited ? "50" : "No limit"}
            disabled={!canEdit || !limited}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "");
              setOwn({ limited: true, dailyLimit: digits ? Number(digits) : null });
            }}
            className="h-9 text-sm"
          />
          <p className="text-[11px] text-subtle">Applies to all leads (not per lead).</p>
          <p className="text-[11px] text-subtle">
            {data.usage.limit === null ? `${data.usage.used} unmasked today` : `${data.usage.used} / ${data.usage.limit} unmasked today`} ·{" "}
            {own ? (
              canEdit ? (
                <button type="button" className="text-brand hover:underline" onClick={() => setOwn(null)}>
                  Use the role&apos;s ({data.limit.role === null ? "no limit" : `${data.limit.role}/day`})
                </button>
              ) : (
                "set for them"
              )
            ) : (
              "the role's limit"
            )}
          </p>
        </div>
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm text-text">
            <input type="checkbox" checked disabled className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" aria-describedby="limit-repeat" />
            <span>
              Prevent multiple unmasking
              <span id="limit-repeat" className="block text-[11px] text-subtle">
                Same lead cannot be unmasked more than once per day — opening it again shows it, and uses nothing.
              </span>
            </span>
          </label>
          <div className="space-y-1">
            <label htmlFor="limit-reset" className="text-xs text-muted">
              Reset time (timezone)
            </label>
            <Select id="limit-reset" disabled value="midnight" className="h-9 text-sm">
              <option value="midnight">12:00 AM ({data.zone})</option>
            </Select>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ─── Sensitive field masking ──────────────────────────────────────────────────────────────────────

export function FieldMaskingPanel({
  userId,
  name,
  data,
  canEdit,
  detailed = false,
}: {
  userId: string;
  name: string;
  data: PersonFieldAccess;
  canEdit: boolean;
  /** On the Field Permissions tab: where each field's answer comes from, under its name. */
  detailed?: boolean;
}) {
  const [choices, setChoicesRaw] = useState<Map<string, FieldPolicy | null>>(() => new Map());
  // Saved and waiting for the page to bring it back, as the actions above.
  const [committed, setCommitted] = useState(false);
  const setChoices: typeof setChoicesRaw = (v) => {
    setCommitted(false);
    setChoicesRaw(v);
  };
  const policyOf = (key: string): FieldPolicy => {
    const row = data.rows.find((r) => r.key === key)!;
    return choices.has(key) ? (choices.get(key) ?? row.inherited) : (row.stored ?? row.inherited);
  };
  const changes = [...choices].filter(([key, p]) => JSON.stringify(p) !== JSON.stringify(data.rows.find((r) => r.key === key)?.stored ?? null));

  useDraftEditor("fields", committed ? 0 : changes.length, {
    label: "field masking",
    save: async (options) => {
      const r = await setPersonFieldAccess(
        userId,
        changes.map(([field, policy]) => ({ field, policy })),
        options,
      );
      if (!r.ok) return r.error;
      setCommitted(true);
      return null;
    },
    discard: () => setChoices(new Map()),
  });

  const edit = (key: string, kind: FieldKind, patch: Partial<FieldPolicy>) => {
    const row = data.rows.find((r) => r.key === key)!;
    const next = normalisePolicy(kind, { ...policyOf(key), ...patch });
    // Back to their role's answer exactly: their own row goes, rather than copying the role's.
    setChoices((prev) => new Map(prev).set(key, JSON.stringify(next) === JSON.stringify(row.inherited) ? null : next));
  };

  return (
    <Card className="p-4">
      <h3 className="text-sm font-semibold text-text">Sensitive field masking</h3>
      <p className="mt-0.5 text-xs text-muted">Select which fields should be masked for {name}.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm">
          <thead className="border-b border-line text-left text-[11px] font-medium leading-tight text-muted">
            <tr>
              <th className="py-2 pr-2">Field</th>
              <th className="w-12 px-1 py-2 text-center">Mask in list</th>
              <th className="w-12 px-1 py-2 text-center">Mask in detail</th>
              <th className="w-[6.5rem] px-1 py-2">Mask format</th>
              <th className="w-14 py-2 pl-1 text-center">Unmask on click</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => {
              const p = policyOf(row.key);
              const masked = p.view && (p.maskInList || p.maskInDetail);
              return (
                <tr key={row.key} className="border-b border-line last:border-0">
                  <td className="py-2 pr-2 text-[13px] text-text">
                    {row.label}
                    {!committed && choices.has(row.key) && <span className="ml-1 text-[11px] text-brand">•</span>}
                    {detailed && <span className="block text-[11px] text-subtle">{!committed && choices.has(row.key) ? "After you save." : row.why}</span>}
                  </td>
                  <td className="px-1 py-2 text-center">
                    <Switch label={`${row.label}: mask in list`} checked={p.view && p.maskInList} disabled={!canEdit || !p.view} onChange={(v) => edit(row.key, row.kind, { maskInList: v })} />
                  </td>
                  <td className="px-1 py-2 text-center">
                    <Switch label={`${row.label}: mask in detail`} checked={p.view && p.maskInDetail} disabled={!canEdit || !p.view} onChange={(v) => edit(row.key, row.kind, { maskInDetail: v })} />
                  </td>
                  <td className="px-1 py-2">
                    <Select
                      aria-label={`${row.label}: mask format`}
                      value={p.view ? p.format : "hidden"}
                      disabled={!canEdit}
                      onChange={(e) =>
                        e.target.value === "hidden"
                          ? edit(row.key, row.kind, { view: false })
                          : edit(row.key, row.kind, { view: true, format: e.target.value as MaskFormat, ...(p.view ? {} : { maskInList: true, maskInDetail: true }) })
                      }
                      className={cn("h-7 w-full max-w-[8rem] border-transparent bg-transparent px-1 font-mono text-[11px]", !masked && p.view && "text-subtle")}
                    >
                      {row.formats.map((f) => (
                        <option key={f} value={f}>
                          {masked ? maskValue(SAMPLE[row.kind], f) : "-"}
                        </option>
                      ))}
                      <option value="hidden">Hidden</option>
                    </Select>
                  </td>
                  <td className="py-2 pl-1 text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--color-brand)] disabled:opacity-50"
                      checked={p.unmask}
                      disabled={!canEdit || !masked}
                      aria-label={`${row.label}: unmask on click`}
                      onChange={(e) => edit(row.key, row.kind, { unmask: e.target.checked })}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Link
        href="/settings/custom-fields"
        className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-base border border-line px-3 text-[13px] text-text transition-colors hover:bg-surface-sunken"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add custom field
      </Link>
    </Card>
  );
}
