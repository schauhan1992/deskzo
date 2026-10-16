"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import type { AccessLevel } from "@prisma/client";
import { setPersonAccessLevels, setPersonPermissions, type PermissionState, type PersonLevelRow } from "@/actions/person-access";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { ACCESS_MODULES, moduleStanding, permissionsOfModule, STANDING_WORDS, type ModuleStanding } from "@/lib/staff/access-modules";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * One person's permissions and reach, against their role's — the Permissions and Record Access tabs of
 * a person (src/actions/person-access.ts).
 *
 * Each action shows what their role gives, a choice — Use role default, Allow or Deny — and what applies
 * now, with why. Record scopes the same way: their role's level, or one of their own. A reason and an end
 * date go with the save, as for any personal exception; every rule the server applies holds — nobody
 * gives more than they have, nobody changes their own, the super admin's is nobody's.
 */

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

const ACTIONS = ["view", "edit", "delete", "assign"] as const;
type Action = (typeof ACTIONS)[number];
const STANDING_TONE: Record<ModuleStanding, "green" | "amber" | "red"> = { full: "green", limited: "amber", none: "red" };

export function PersonAccessEditor({
  view,
  userId,
  name,
  permissions,
  grid,
  canEdit,
  lockedWhy,
}: {
  view: "permissions" | "records";
  userId: string;
  name: string;
  permissions: PersonPermissionRow[];
  grid: PersonLevelRow[];
  canEdit: boolean;
  lockedWhy: string | null;
}) {
  const router = useRouter();
  const byKey = useMemo(() => new Map(permissions.map((p) => [p.key, p])), [permissions]);
  const savedState = (p: PersonPermissionRow): PermissionState => (p.own && !p.own.expired ? (p.own.allowed ? "allow" : "deny") : "inherit");
  const [states, setStates] = useState<Map<string, PermissionState>>(() => new Map());
  const [levels, setLevels] = useState<Map<string, AccessLevel | "">>(() => new Map());
  const [active, setActive] = useState(ACCESS_MODULES[0]!.key);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [until, setUntil] = useState("");
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const stateOf = (p: PersonPermissionRow) => states.get(p.key) ?? savedState(p);
  const holdsAfter = (key: string) => {
    const p = byKey.get(key);
    if (!p) return false;
    const s = stateOf(p);
    return s === "inherit" ? p.role : s === "allow";
  };
  const levelSlot = (record: string, action: string) => `${record}:${action}`;
  const levelOf = (row: PersonLevelRow, action: Action): AccessLevel | "" => levels.get(levelSlot(row.key, action)) ?? row.cells[action].own?.level ?? "";
  const effectiveLevel = (row: PersonLevelRow, action: Action): AccessLevel => {
    const own = levelOf(row, action);
    return own === "" ? row.cells[action].role : own;
  };

  const permChanges = permissions.filter((p) => states.has(p.key) && states.get(p.key) !== savedState(p)).map((p) => ({ key: p.key, state: states.get(p.key)! }));
  const levelChanges = grid.flatMap((row) =>
    ACTIONS.flatMap((action) => {
      const picked = levels.get(levelSlot(row.key, action));
      if (picked === undefined) return [];
      const saved = row.cells[action].own?.level ?? "";
      return picked === saved ? [] : [{ record: row.key, action, level: picked === "" ? null : picked }];
    }),
  );
  const changes = permChanges.length + levelChanges.length;

  const save = () =>
    start(async () => {
      setNotice(null);
      const options = { reason: reason.trim() || undefined, expiresAt: until || null };
      if (permChanges.length) {
        const r = await setPersonPermissions(userId, permChanges, options);
        if (!r.ok) {
          setNotice({ tone: "error", text: r.error });
          router.refresh();
          return;
        }
      }
      if (levelChanges.length) {
        const r = await setPersonAccessLevels(userId, levelChanges, options);
        if (!r.ok) {
          setNotice({ tone: "error", text: r.error });
          router.refresh();
          return;
        }
      }
      setStates(new Map());
      setLevels(new Map());
      setReason("");
      setNotice({ tone: "success", text: `Saved ${changes} change${changes === 1 ? "" : "s"} for ${name}.` });
      router.refresh();
    });

  const locked = !canEdit;
  const levelTable = (rows: PersonLevelRow[]) => (
    <div className="overflow-x-auto rounded-base border border-line">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
          <tr>
            <th className="px-3 py-2">Records</th>
            {ACTIONS.map((a) => (
              <th key={a} className="px-2 py-2 capitalize">
                {a}
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
                const cell = row.cells[a];
                if (cell.absent) {
                  return (
                    <td key={a} className="px-2 py-2 text-subtle">
                      —
                    </td>
                  );
                }
                const value = levelOf(row, a);
                return (
                  <td key={a} className="px-2 py-2">
                    <Select
                      aria-label={`${row.label}, ${a}`}
                      value={value}
                      disabled={locked || pending}
                      title={cell.why}
                      onChange={(e) => {
                        setNotice(null);
                        setLevels((m) => new Map(m).set(levelSlot(row.key, a), e.target.value as AccessLevel | ""));
                      }}
                      className="h-8 min-w-[9rem] text-sm"
                    >
                      <option value="">Role default — {LEVEL_WORDS[cell.role]}</option>
                      {row.levels.map((l) => (
                        <option key={l} value={l}>
                          {LEVEL_WORDS[l]}
                        </option>
                      ))}
                    </Select>
                    <span className="mt-1 block text-[11px] text-subtle">Now: {LEVEL_WORDS[effectiveLevel(row, a)]}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const footer = (
    <div className="space-y-3 border-t border-line bg-surface px-4 py-3">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      {!locked && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="pa-reason" className="text-xs">
                Reason
              </Label>
              <Input id="pa-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why they differ from their role" className="h-8 w-72 text-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pa-until" className="text-xs">
                Expires (optional)
              </Label>
              <Input id="pa-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="h-8 text-sm" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {changes > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setStates(new Map());
                  setLevels(new Map());
                }}
              >
                Discard
              </Button>
            )}
            <Button size="sm" onClick={save} disabled={pending || changes === 0}>
              {pending ? "Saving…" : changes ? `Save ${changes} change${changes === 1 ? "" : "s"}` : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  if (view === "records") {
    return (
      <div className="overflow-hidden rounded-base border border-line">
        <div className="space-y-3 p-4">
          <p className="text-sm text-muted">Which records {name} reaches, for each action: their role&apos;s level, or one of their own. Edit, delete and assign can&apos;t reach wider than view.</p>
          {lockedWhy && <p className="rounded-base bg-info-bg px-3 py-2 text-sm text-info">{lockedWhy}</p>}
          {levelTable(grid)}
        </div>
        {footer}
      </div>
    );
  }

  const current = ACCESS_MODULES.find((m) => m.key === active)!;
  const term = search.trim().toLowerCase();
  const rowsHere = grid.filter((r) => (current.records as readonly string[]).includes(r.key));
  const keysHere = permissionsOfModule(current.key)
    .map((d) => byKey.get(d.key))
    .filter((p): p is PersonPermissionRow => Boolean(p))
    .filter((p) => !term || p.label.toLowerCase().includes(term) || p.description.toLowerCase().includes(term));
  const standing = (key: string) => {
    const m = ACCESS_MODULES.find((x) => x.key === key)!;
    return moduleStanding(m, holdsAfter, (record) => {
      const row = grid.find((r) => r.key === record);
      return row ? effectiveLevel(row, "view") !== "NONE" : false;
    });
  };

  return (
    <div className="@container overflow-hidden rounded-base border border-line">
      <div className="grid grid-cols-[minmax(0,1fr)] @3xl:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Modules" className="min-w-0 border-b border-line bg-surface-sunken @3xl:border-b-0 @3xl:border-r">
          <ul className="flex gap-1 overflow-x-auto p-2 @3xl:block @3xl:max-h-[40rem] @3xl:space-y-0.5 @3xl:overflow-y-auto">
            {ACCESS_MODULES.map((m) => {
              const s = standing(m.key);
              const exceptions = permissionsOfModule(m.key).filter((d) => {
                const p = byKey.get(d.key);
                return p ? stateOf(p) !== "inherit" : false;
              }).length;
              return (
                <li key={m.key} className="shrink-0 @3xl:shrink">
                  <button
                    type="button"
                    onClick={() => setActive(m.key)}
                    aria-current={active === m.key ? "true" : undefined}
                    className={`flex w-full items-start justify-between gap-2 whitespace-nowrap rounded-base px-2.5 py-2 text-left text-sm @3xl:whitespace-normal ${active === m.key ? "bg-brand/10 ring-1 ring-brand/30" : "hover:bg-surface"}`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium text-text">{m.label}</span>
                      <span className="hidden text-[11px] text-subtle @3xl:block">{exceptions ? `${exceptions} exception${exceptions === 1 ? "" : "s"}` : m.description}</span>
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
              <h3 className="text-sm font-semibold text-text">
                {current.label} — permissions for {name}
              </h3>
              <p className="text-xs text-muted">{current.description}</p>
            </div>
            <Badge tone={STANDING_TONE[standing(current.key)]}>{STANDING_WORDS[standing(current.key)]}</Badge>
          </div>
          {lockedWhy && <p className="rounded-base bg-info-bg px-3 py-2 text-sm text-info">{lockedWhy}</p>}
          {rowsHere.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-subtle">Record scope</h4>
              {levelTable(rowsHere)}
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
              <table className="w-full min-w-[640px] text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
                  <tr>
                    <th className="px-3 py-2">Action</th>
                    <th className="px-3 py-2">Role</th>
                    <th className="w-48 px-3 py-2">Permission</th>
                    <th className="px-3 py-2">Effective</th>
                  </tr>
                </thead>
                <tbody>
                  {keysHere.map((p) => {
                    const state = stateOf(p);
                    const after = holdsAfter(p.key);
                    const changed = states.has(p.key) && states.get(p.key) !== savedState(p);
                    return (
                      <tr key={p.key} className="border-b border-line last:border-0 align-top">
                        <td className="px-3 py-2.5">
                          <span className="font-medium text-text">{p.label}</span>
                          {p.tier === "critical" && <Badge tone="red" className="ml-1.5">Critical</Badge>}
                          {p.tier === "sensitive" && <Badge tone="amber" className="ml-1.5">Sensitive</Badge>}
                          <span className="block text-xs text-subtle">{p.description}</span>
                          {p.selfExcluded && <span className="block text-[11px] text-subtle">Never on their own records.</span>}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-muted">{p.role ? "Allowed" : "Not given"}</td>
                        <td className="px-3 py-2.5">
                          <Select
                            aria-label={`${p.label} for ${name}`}
                            value={state}
                            disabled={locked || pending}
                            onChange={(e) => {
                              setNotice(null);
                              setStates((m) => new Map(m).set(p.key, e.target.value as PermissionState));
                            }}
                            className={`h-8 text-sm ${state === "allow" ? "text-success" : state === "deny" ? "text-danger" : ""}`}
                          >
                            <option value="inherit">Use role default</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </Select>
                          {p.own && !p.own.expired && !changed && (
                            <span className="mt-1 block text-[11px] text-subtle">
                              {p.own.reason ? `“${p.own.reason}”` : "No reason given"}
                              {p.own.expiresAt ? ` · until ${new Date(new Date(p.own.expiresAt).getTime() - 1).toISOString().slice(0, 10)}` : ""}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge tone={after ? "green" : "default"}>{after ? "Held" : "Not held"}</Badge>
                          <span className="mt-1 block max-w-[16rem] text-[11px] text-subtle">{changed ? "After you save." : p.why}</span>
                        </td>
                      </tr>
                    );
                  })}
                  {keysHere.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-6 text-center text-subtle">
                        {term ? `No action matches “${search}”.` : "Nothing to allow here beyond the records above."}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {footer}
    </div>
  );
}
