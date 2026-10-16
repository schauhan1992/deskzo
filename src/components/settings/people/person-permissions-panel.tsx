"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AccessLevel } from "@prisma/client";
import { Lock, Plus } from "lucide-react";
import { setPersonAccessLevels, setPersonPermissions, type ModulePreview, type PermissionState, type PersonLevelRow } from "@/actions/person-access";
import { setPersonFieldAccess, setPersonUnmaskLimit, type PersonFieldAccess } from "@/actions/field-access";
import type { AccessAction, AccessRecord } from "@/lib/authz/access";
import { ACCESS_MODULES, actionRowsOf, type ActionRowSpec } from "@/lib/staff/access-modules";
import { maskValue, normalisePolicy, type FieldKind, type FieldPolicy, type MaskFormat } from "@/lib/authz/field-policy";
import { Badge, Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Switch } from "@/components/settings/access/switch";
import { ModuleIcon } from "@/components/settings/access/module-icon";
import { ActionIcon } from "@/components/settings/access/action-icon";
import { useDraftEditor } from "@/components/settings/people/person-draft";
import type { PersonPermissionRow } from "@/components/settings/people/person-access-editor";
import { cn } from "@/lib/utils";

const SCOPE_LABEL: Record<AccessLevel, string> = { NONE: "None", OWN: "Own", TEAM: "Team", BRANCH: "Branch", ALL: "All", FOLLOW: "Account" };
const SAMPLE: Record<FieldKind, string> = { text: "Acme Technologies", email: "sales@globex.com", phone: "+91 98765 43210", address: "12 MG Road, Pune", choice: "Website" };
const STANDING = { full: { tone: "green", text: "Full access" }, limited: { tone: "amber", text: "Limited access" }, none: { tone: "red", text: "No access" } } as const;

type Slot = `${string}:${string}`;
const slot = (record: string, action: string) => `${record}:${action}` as Slot;

/**
 * One person's Permissions tab: the modules; for the one open, each action with its Permission (their
 * role's answer, or Allow or Deny for them alone) and its Record scope; and, for CRM, their daily
 * unmasking limit and which lead fields are masked for them — with their effective access beside.
 *
 * Nothing is saved here: every change waits for "Save changes" at the top of the page
 * (src/components/settings/people/person-draft.tsx), which saves each kind through its own action.
 */
export function PersonPermissionsPanel({
  userId,
  name,
  permissions,
  grid,
  fields,
  preview,
  canEdit,
  lockedWhy,
}: {
  userId: string;
  name: string;
  permissions: PersonPermissionRow[];
  grid: PersonLevelRow[];
  fields: PersonFieldAccess | null;
  preview: ModulePreview[] | null;
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const [active, setActive] = useState(ACCESS_MODULES[0]!.key);
  const current = ACCESS_MODULES.find((m) => m.key === active)!;
  const showLeadPanels = active === "crm" && fields !== null;

  return (
    <div className="@container">
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[11.5rem_minmax(0,1fr)] @[66rem]:grid-cols-[11.5rem_minmax(0,1fr)_25rem]">
        <Card className="self-start p-2 @3xl:row-span-2">
          <h3 className="px-2 pb-2 pt-1 text-sm font-semibold text-text">Modules</h3>
          <ul className="flex gap-1 overflow-x-auto @3xl:block @3xl:space-y-0.5 @3xl:overflow-visible">
            {ACCESS_MODULES.map((m) => (
              <li key={m.key} className="shrink-0 @3xl:shrink">
                <button
                  type="button"
                  onClick={() => setActive(m.key)}
                  aria-current={active === m.key ? "true" : undefined}
                  className={cn(
                    "flex w-full items-start gap-2.5 whitespace-nowrap rounded-base border-l-2 px-2 py-2 text-left transition-colors @3xl:whitespace-normal",
                    active === m.key ? "border-brand bg-brand/10" : "border-transparent hover:bg-surface-sunken",
                  )}
                >
                  <ModuleIcon icon={m.icon} className={cn("mt-0.5 h-4 w-4 shrink-0", active === m.key ? "text-brand" : "text-muted")} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-text">{m.label}</span>
                    <span className="hidden text-[11px] leading-snug text-subtle @3xl:line-clamp-2">{m.description}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <div className="min-w-0 space-y-4">
          <Card className="min-w-0 p-4">
            <h3 className="text-base font-semibold text-text">
              {current.label} – Permissions for {name}
            </h3>
            <p className="mt-0.5 text-xs text-muted">
              {showLeadPanels ? "Configure action permissions, field masking and daily unmasking limits." : `Configure what ${name} may do in ${current.label}.`}
            </p>
            {lockedWhy && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-subtle">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                {lockedWhy}
              </p>
            )}
            <PersonActions key={userId} userId={userId} moduleKey={active} permissions={permissions} grid={grid} canEdit={canEdit} />
          </Card>
          {/* Kept mounted on every module, so what was changed here waits for "Save changes" while another is open. */}
          {fields && (
            <div className={showLeadPanels ? undefined : "hidden"}>
              <UnmaskLimitPanel key={`limit:${userId}`} userId={userId} name={name} data={fields} canEdit={canEdit && fields.editable} />
            </div>
          )}
        </div>

        <div className="min-w-0 space-y-4 @3xl:col-start-2 @[66rem]:col-start-3 @[66rem]:row-start-1">
          {fields && (
            <div className={showLeadPanels ? undefined : "hidden"}>
              <FieldMaskingPanel key={`fields:${userId}`} userId={userId} name={name} data={fields} canEdit={canEdit && fields.editable} />
            </div>
          )}
          {preview && (
            <Card className="p-4">
              <h3 className="text-sm font-semibold text-text">Effective access for {name}</h3>
              <ul className="mt-3 space-y-1">
                {preview.map((m) => {
                  const mod = ACCESS_MODULES.find((x) => x.key === m.key);
                  const s = STANDING[m.standing];
                  return (
                    <li key={m.key} className="flex items-center gap-2.5 rounded-base px-1 py-1.5 text-sm">
                      {mod && <ModuleIcon icon={mod.icon} className="h-4 w-4 shrink-0 text-muted" />}
                      <span className="min-w-0 flex-1 truncate text-text">{m.label}</span>
                      <Badge tone={s.tone}>{s.text}</Badge>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── The module's actions ─────────────────────────────────────────────────────────────────────────

function PersonActions({
  userId,
  moduleKey,
  permissions,
  grid,
  canEdit,
}: {
  userId: string;
  moduleKey: string;
  permissions: PersonPermissionRow[];
  grid: PersonLevelRow[];
  canEdit: boolean;
}) {
  const byKey = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);
  const savedState = (p: PersonPermissionRow): PermissionState => (p.own && !p.own.expired ? (p.own.allowed ? "allow" : "deny") : "inherit");
  const [states, setStates] = useState<Map<string, PermissionState>>(() => new Map());
  const [levels, setLevels] = useState<Map<Slot, AccessLevel | null>>(() => new Map());

  const stateOf = (key: string): PermissionState => {
    const p = byKey.get(key);
    return states.get(key) ?? (p ? savedState(p) : "inherit");
  };
  const holdsAfter = (key: string): boolean => {
    const p = byKey.get(key);
    const s = stateOf(key);
    return s === "inherit" ? Boolean(p?.role) : s === "allow";
  };
  const cellOf = (record: AccessRecord, action: AccessAction) => grid.find((r) => r.key === record)?.cells[action];
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

  const permissionChanges = [...states].filter(([key, s]) => {
    const p = byKey.get(key);
    return p ? savedState(p) !== s : false;
  });
  const levelChanges = [...levels].filter(([s, level]) => {
    const [record, action] = s.split(":") as [AccessRecord, AccessAction];
    return (cellOf(record, action)?.own?.level ?? null) !== level;
  });
  const count = permissionChanges.length + levelChanges.length;

  useDraftEditor("actions", count, {
    label: "permissions",
    save: async (options) => {
      if (permissionChanges.length) {
        const r = await setPersonPermissions(userId, permissionChanges.map(([key, state]) => ({ key, state })), options);
        if (!r.ok) return r.error;
      }
      if (levelChanges.length) {
        const r = await setPersonAccessLevels(
          userId,
          levelChanges.map(([s, level]) => {
            const [record, action] = s.split(":");
            return { record: record!, action: action!, level };
          }),
          options,
        );
        if (!r.ok) return permissionChanges.length ? `The permissions were saved, but not the record access: ${r.error}` : r.error;
      }
      setStates(new Map());
      setLevels(new Map());
      return null;
    },
    discard: () => {
      setStates(new Map());
      setLevels(new Map());
    },
  });

  const rows = actionRowsOf(
    moduleKey,
    grid.map((r) => ({ key: r.key, label: r.label, actions: r.actions })),
  );

  /** The row's Permission: a permission's answer, or — for a record without one — whether it reaches any of them. */
  const permissionOf = (row: ActionRowSpec): { value: PermissionState; roleAllows: boolean; allowed: boolean } => {
    if (row.kind === "key") return { value: stateOf(row.key), roleAllows: Boolean(byKey.get(row.key)?.role), allowed: holdsAfter(row.key) };
    if (row.viewKey) {
      const allowed = holdsAfter(row.viewKey) && levelAfter(row.record, row.action) !== "NONE";
      return { value: stateOf(row.viewKey), roleAllows: Boolean(byKey.get(row.viewKey)?.role), allowed };
    }
    const own = ownLevel(row.record, row.action);
    const cell = cellOf(row.record, row.action);
    return { value: own === null ? "inherit" : own === "NONE" ? "deny" : "allow", roleAllows: (cell?.role ?? "NONE") !== "NONE", allowed: levelAfter(row.record, row.action) !== "NONE" };
  };

  const setPermission = (row: ActionRowSpec, value: PermissionState) => {
    if (row.kind === "key" || row.viewKey) {
      const key = row.kind === "key" ? row.key : row.viewKey!;
      setStates((prev) => new Map(prev).set(key, value));
      return;
    }
    const cell = cellOf(row.record, row.action);
    const gridRow = grid.find((r) => r.key === row.record);
    if (!cell || !gridRow) return;
    const level: AccessLevel | null =
      value === "inherit" ? null : value === "deny" ? "NONE" : cell.role !== "NONE" ? cell.role : (gridRow.levels.find((l) => l !== "NONE") ?? "OWN");
    setLevels((prev) => new Map(prev).set(slot(row.record, row.action), level));
  };

  const groups = groupRows(rows, grid);

  /** Why the row's Permission is what it is: their own exception (its reason and end), or how it is held. */
  const noteOf = (row: ActionRowSpec): string | undefined => {
    const key = row.kind === "key" ? row.key : row.viewKey;
    const p = key ? byKey.get(key) : null;
    if (!p) return row.kind === "record" ? cellOf(row.record, row.action)?.why : undefined;
    if (!p.own || p.own.expired) return p.why;
    const until = p.own.expiresAt ? ` · until ${new Date(new Date(p.own.expiresAt).getTime() - 1).toISOString().slice(0, 10)}` : "";
    return `${p.own.allowed ? "Allowed" : "Denied"} for them alone — ${p.own.reason ? `“${p.own.reason}”` : "no reason given"}${until}`;
  };

  return (
    <div className="mt-4 space-y-4">
      {groups.map((g) => (
        <section key={g.title}>
          <h4 className="mb-2 text-sm font-semibold text-text">{g.title}</h4>
          <div className="overflow-x-auto rounded-base border border-line">
            <table className="w-full min-w-[24rem] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
                <tr>
                  <th className="px-3 py-2">Action</th>
                  <th className="w-[8rem] px-1 py-2">Permission</th>
                  <th className="w-[10rem] px-1 py-2 pr-2">Record scope</th>
                </tr>
              </thead>
              <tbody>
                {g.rows.map((row) => {
                  const p = permissionOf(row);
                  const gridRow = row.kind === "record" ? grid.find((r) => r.key === row.record) : null;
                  const cell = row.kind === "record" ? cellOf(row.record, row.action) : null;
                  return (
                    <tr key={row.id} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2.5">
                          <ActionIcon row={row} className="h-4 w-4 shrink-0 text-muted" />
                          <span className="text-text">{row.label}</span>
                        </span>
                      </td>
                      <td className="px-1 py-2">
                        <Select
                          aria-label={`${row.label}: permission`}
                          title={noteOf(row)}
                          value={p.value}
                          disabled={!canEdit}
                          onChange={(e) => setPermission(row, e.target.value as PermissionState)}
                          className={cn(
                            "h-8 w-full text-xs font-medium",
                            p.allowed ? "border-success/40 bg-success-bg text-success" : "border-danger/40 bg-danger-bg text-danger",
                          )}
                        >
                          <option value="inherit">{p.roleAllows ? "Allow" : "Deny"} (role)</option>
                          <option value="allow">Allow</option>
                          <option value="deny">Deny</option>
                        </Select>
                      </td>
                      <td className="px-1 py-2 pr-2">
                        {row.kind === "record" && gridRow && cell && p.allowed ? (
                          <Select
                            aria-label={`${row.label}: record scope`}
                            title={`Own: ${gridRow.ownMeans}`}
                            value={ownLevel(row.record, row.action) ?? ""}
                            disabled={!canEdit}
                            onChange={(e) => setLevels((prev) => new Map(prev).set(slot(row.record, row.action), e.target.value === "" ? null : (e.target.value as AccessLevel)))}
                            className="h-8 w-full text-xs"
                          >
                            <option value="">{SCOPE_LABEL[cell.role === "NONE" ? levelAfter(row.record, row.action) : cell.role]} (role)</option>
                            {gridRow.levels
                              .filter((l) => l !== "NONE")
                              .map((l) => (
                                <option key={l} value={l}>
                                  {SCOPE_LABEL[l]}
                                </option>
                              ))}
                          </Select>
                        ) : (
                          <span className="block px-2 text-xs text-subtle" title={row.kind === "key" ? "Not a matter of which records" : undefined}>
                            {row.kind === "record" ? "None" : "—"}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {groups.length === 0 && <p className="text-sm text-subtle">Nothing to grant in this module beyond its place in the menu.</p>}
    </div>
  );
}

/** "Lead actions", "Account actions"… for each record, then the module's other permissions. */
function groupRows(rows: ActionRowSpec[], grid: PersonLevelRow[]) {
  const out: { title: string; rows: ActionRowSpec[] }[] = [];
  for (const row of rows) {
    const title = row.kind === "record" ? `${singular(grid.find((g) => g.key === row.record)?.label ?? row.record)} actions` : "Other actions";
    const group = out.find((g) => g.title === title);
    if (group) group.rows.push(row);
    else out.push({ title, rows: [row] });
  }
  return out;
}

function singular(label: string): string {
  const first = label.split(/[ ,&]/)[0] ?? label;
  return first.endsWith("ies") ? `${first.slice(0, -3)}y` : first.endsWith("s") ? first.slice(0, -1) : first;
}

// ─── Unmasking limits (daily) ─────────────────────────────────────────────────────────────────────

export function UnmaskLimitPanel({ userId, name, data, canEdit }: { userId: string; name: string; data: PersonFieldAccess; canEdit: boolean }) {
  const saved = data.limit.own;
  const [own, setOwn] = useState<{ limited: boolean; dailyLimit: number | null } | null>(saved ? { limited: saved.limited, dailyLimit: saved.dailyLimit } : null);
  const limited = own ? own.limited : data.limit.role !== null;
  const value = own ? own.dailyLimit : data.limit.role;
  const dirty = JSON.stringify(own) !== JSON.stringify(saved ? { limited: saved.limited, dailyLimit: saved.dailyLimit } : null);

  useDraftEditor("limit", dirty ? 1 : 0, {
    label: "daily limit",
    save: async (options) => {
      const r = await setPersonUnmaskLimit(userId, own ? { limited: own.limited, dailyLimit: own.dailyLimit ?? undefined } : null, options);
      return r.ok ? null : r.error;
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
  const [choices, setChoices] = useState<Map<string, FieldPolicy | null>>(() => new Map());
  const policyOf = (key: string): FieldPolicy => {
    const row = data.rows.find((r) => r.key === key)!;
    return choices.has(key) ? (choices.get(key) ?? row.inherited) : (row.stored ?? row.inherited);
  };
  const changes = [...choices].filter(([key, p]) => JSON.stringify(p) !== JSON.stringify(data.rows.find((r) => r.key === key)?.stored ?? null));

  useDraftEditor("fields", changes.length, {
    label: "field masking",
    save: async (options) => {
      const r = await setPersonFieldAccess(
        userId,
        changes.map(([field, policy]) => ({ field, policy })),
        options,
      );
      if (!r.ok) return r.error;
      setChoices(new Map());
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
                    {choices.has(row.key) && <span className="ml-1 text-[11px] text-brand">•</span>}
                    {detailed && <span className="block text-[11px] text-subtle">{choices.has(row.key) ? "After you save." : row.why}</span>}
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
