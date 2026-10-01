"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, Search } from "lucide-react";
import { createRole, updateRole } from "@/actions/role";
import { setRolePermissions } from "@/actions/permission";
import { PERMISSION_GROUP_ORDER } from "@/lib/permissions";
import { moduleNote } from "@/lib/staff/permission-modules";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import type { CatalogueEntry, ModuleStates, RoleCard } from "@/components/settings/staff/types";

/**
 * Defining a role: its name, its description, and a checkbox for every permission in the catalogue.
 *
 * This replaces the matrix as the way a role is defined. One role at a time, grouped as the
 * catalogue groups them, two columns of plain checkboxes — the shape somebody can read and decide
 * from. The matrix stays reachable as "Compare roles" for what only it can do: every role side by
 * side, the difference between a registry default and a stored answer, and the presets.
 *
 * ## What a tick means
 *
 * A tick is what the role grants, as the resolver reads the role: a stored answer if there is one,
 * otherwise the registry default (and for Admin, everything not taken away). Saving writes only the
 * boxes that changed, through `setRolePermissions` — which applies `setRolePermission`'s rules to each
 * of them before writing any — so a box left alone keeps following the default, and what the role
 * grants afterwards is exactly what was ticked. Permissions here carry no own/team/everyone scope:
 * where a permission's reach varies, the wider reach is its own permission ("View all field visits"),
 * with a box of its own.
 *
 * ## What can't be ticked, and why
 *
 * A box the viewer can't change is disabled with its reason as the tooltip, the same reasons the
 * server would give: only a super admin changes what Admin holds or grants a super-admin-only key;
 * nobody grants or revokes what they don't hold themselves; nobody takes away their own way into
 * these screens. A reviewer (`permissions.view` without `.manage`) sees the same dialog with every
 * box disabled and no Save.
 */

export type RoleDialogProps = {
  /** The role to edit, or null for a new one. */
  role: RoleCard | null;
  catalogue: CatalogueEntry[];
  modules: ModuleStates;
  mayManage: boolean;
  viewerIsSuperAdmin: boolean;
  /** What the viewer holds — the keys they may grant or revoke for a role. */
  viewerHolds: string[];
  viewerRole: string;
  /** Of "Review who can do what" and "Change roles and permissions", the ones the viewer holds through their role. */
  ownAccessThroughRole: string[];
  onClose: () => void;
};

const TIER_BADGE: Record<string, { tone: "red" | "amber"; label: string } | undefined> = {
  critical: { tone: "red", label: "Critical" },
  sensitive: { tone: "amber", label: "Sensitive" },
};

export function RoleDialog({
  role,
  catalogue,
  modules,
  mayManage,
  viewerIsSuperAdmin,
  viewerHolds,
  viewerRole,
  ownAccessThroughRole,
  onClose,
}: RoleDialogProps) {
  const router = useRouter();
  // A new role becomes an existing one the moment it is created, even if its permissions then fail.
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const roleKey = role?.key ?? createdKey;
  const initialName = role?.name ?? "";
  const initialDescription = role?.description ?? "";
  const [savedHeld, setSavedHeld] = useState<Set<string>>(() => new Set(role?.held ?? []));
  const [savedDetails, setSavedDetails] = useState({ name: initialName, description: initialDescription });

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(role?.held ?? []));
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [saving, startSave] = useTransition();
  // The question replaces the buttons it is about, so focus goes to the safe answer rather than to <body>.
  const keepEditingRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirmDiscard) keepEditingRef.current?.focus();
  }, [confirmDiscard]);

  const holds = useMemo(() => new Set(viewerHolds), [viewerHolds]);
  const isAdminRole = roleKey === "ADMIN";
  const detailsLocked = !mayManage;
  const permissionsLocked = !mayManage || (isAdminRole && !viewerIsSuperAdmin);
  const readOnly = detailsLocked && permissionsLocked;

  /** Why a box can't be changed, or null when it can. */
  const lockReason = (entry: CatalogueEntry): string | null => {
    if (!mayManage) return "You can review roles but not change them.";
    if (isAdminRole && !viewerIsSuperAdmin) return "Only a super admin can change what admins can do.";
    if (viewerIsSuperAdmin) return null;
    if (entry.superAdminOnly) return "Only a super admin can grant this permission.";
    if (!holds.has(entry.key)) return "You don't hold this yourself, so you can't change it for a role.";
    if (roleKey === viewerRole && ownAccessThroughRole.includes(entry.key) && savedHeld.has(entry.key)) {
      return "You hold this through this role. Taking it away would lock you out of putting it back.";
    }
    return null;
  };

  const term = search.trim().toLowerCase();
  const matches = (entry: CatalogueEntry) =>
    !term || entry.label.toLowerCase().includes(term) || entry.key.toLowerCase().includes(term);

  const groups = useMemo(() => {
    const byGroup = new Map<string, CatalogueEntry[]>();
    for (const entry of catalogue) {
      const list = byGroup.get(entry.group) ?? [];
      list.push(entry);
      byGroup.set(entry.group, list);
    }
    const order = [...PERMISSION_GROUP_ORDER, ...[...byGroup.keys()].filter((g) => !(PERMISSION_GROUP_ORDER as readonly string[]).includes(g))];
    return order.filter((g) => byGroup.has(g)).map((g) => ({ group: g, entries: byGroup.get(g)! }));
  }, [catalogue]);

  const visibleGroups = groups
    .map(({ group, entries }) => ({ group, entries: entries.filter(matches) }))
    .filter((g) => g.entries.length > 0);

  const permissionsDirty =
    ticked.size !== savedHeld.size || [...ticked].some((k) => !savedHeld.has(k));
  const detailsDirty = name.trim() !== savedDetails.name.trim() || description.trim() !== savedDetails.description.trim();
  const dirty = !readOnly && (permissionsDirty || detailsDirty || (!roleKey && name.trim().length > 0));

  function toggle(key: string, on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleAll(entries: CatalogueEntry[], on: boolean) {
    setTicked((prev) => {
      const next = new Set(prev);
      for (const entry of entries) {
        if (lockReason(entry)) continue;
        if (on) next.add(entry.key);
        else next.delete(entry.key);
      }
      return next;
    });
  }

  /** Closing with unsaved changes asks first, whichever way it was asked for — Cancel, ✕, Escape or outside. */
  function requestClose() {
    if (dirty && !saving) setConfirmDiscard(true);
    else onClose();
  }

  function save() {
    setError(null);
    setConfirmDiscard(false);
    startSave(async () => {
      let key = roleKey;
      if (!key) {
        const made = await createRole({ name, description });
        if (!made.ok) {
          setError(made.error);
          return;
        }
        key = made.data.key;
        setCreatedKey(key);
        setSavedDetails({ name: name.trim(), description: description.trim() });
        setSavedHeld(new Set());
      } else if (detailsDirty && !detailsLocked) {
        const renamed = await updateRole({ key, name, description });
        if (!renamed.ok) {
          setError(renamed.error);
          return;
        }
        setSavedDetails({ name: name.trim(), description: description.trim() });
      }

      if (!permissionsLocked) {
        const before = createdKey || !role ? new Set<string>() : savedHeld;
        const changes = catalogue
          .filter((entry) => ticked.has(entry.key) !== before.has(entry.key))
          .map((entry) => ({ key: entry.key, allowed: ticked.has(entry.key) }));
        if (changes.length > 0) {
          const result = await setRolePermissions(key, changes);
          if (!result.ok) {
            router.refresh();
            setError(role ? result.error : `The role was created, but its permissions weren't saved: ${result.error}`);
            return;
          }
        }
      }
      router.refresh();
      onClose();
    });
  }

  const title = !roleKey
    ? "New role"
    : readOnly
      ? `Role: ${savedDetails.name || initialName}`
      : `Edit role: ${savedDetails.name || initialName}`;
  const selectedCount = ticked.size;

  return (
    <Dialog open onClose={requestClose} title={title} large>
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Permissions are enforced on the server for every action, not just hidden in the UI.
        </p>

        {readOnly && (
          <p className="flex items-start gap-2 rounded-base bg-info-bg px-3 py-2 text-sm text-info">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            You can review roles but not change them.
          </p>
        )}
        {!readOnly && isAdminRole && !viewerIsSuperAdmin && (
          <p className="flex items-start gap-2 rounded-base bg-info-bg px-3 py-2 text-sm text-info">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Only a super admin can change what admins can do — otherwise an admin could widen their own role and every
            other admin would inherit it. You can still rename it.
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-dialog-name">Role name *</Label>
            <Input
              id="role-dialog-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={detailsLocked}
              autoComplete="off"
              placeholder="Regional manager"
              aria-describedby="role-dialog-key"
            />
            <p id="role-dialog-key" className="text-xs text-subtle">
              {roleKey ? (
                <>
                  Stays <code className="font-mono">{roleKey}</code> underneath, so renaming changes nothing anyone holds.
                </>
              ) : (
                <>
                  Its key will be <code className="font-mono">{keyPreview(name) || "…"}</code> and never changes; the
                  name can.
                </>
              )}
            </p>
          </div>
          <div className="space-y-1.5 sm:row-span-2">
            <Label htmlFor="role-dialog-description">Description</Label>
            <Textarea
              id="role-dialog-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={detailsLocked}
              rows={3}
              placeholder="Runs a territory and owns its pipeline"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-text" aria-live="polite">
              Permissions ({selectedCount} selected)
            </h3>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search permissions…"
                className="h-8 pl-8 text-sm"
                aria-label="Search permissions"
              />
            </div>
          </div>
          {!roleKey && (
            <p className="text-xs text-subtle">A new role starts holding nothing. Tick what it needs.</p>
          )}
          {roleKey && !readOnly && (
            <p className="text-xs text-subtle">
              This is what the role gives everyone who holds it. A person can hold more through an exception or a
              report — Who can shows that.
            </p>
          )}

          {visibleGroups.map(({ group, entries }) => {
            const editable = entries.filter((e) => !lockReason(e));
            const editableOn = editable.filter((e) => ticked.has(e.key)).length;
            const all = editable.length > 0 && editableOn === editable.length;
            const some = editableOn > 0 && !all;
            const onCount = entries.filter((e) => ticked.has(e.key)).length;
            const core = entries.filter((e) => e.modules.length === 0);
            const byModule = new Map<string, CatalogueEntry[]>();
            for (const entry of entries) {
              if (entry.modules.length === 0) continue;
              const id = entry.modules.join("+");
              byModule.set(id, [...(byModule.get(id) ?? []), entry]);
            }
            return (
              <fieldset key={group} className="rounded-base border border-line px-4 pb-4 pt-1">
                <legend className="px-1 text-sm font-medium text-text">{group}</legend>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                  <label className="flex items-center gap-2 text-xs font-medium text-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-[var(--brand)]"
                      checked={all}
                      ref={(el) => {
                        if (el) el.indeterminate = some;
                      }}
                      disabled={editable.length === 0 || saving}
                      onChange={(e) => toggleAll(entries, e.target.checked)}
                      aria-label={`Select all in ${group}`}
                    />
                    Select all
                  </label>
                  <span className="text-xs text-subtle tabular-nums">
                    {onCount} of {entries.length}
                  </span>
                </div>
                <PermissionGrid entries={core} ticked={ticked} lockReason={lockReason} disabled={saving} onToggle={toggle} />
                {[...byModule].map(([id, list]) => {
                  const moduleKeys = list[0]!.modules;
                  const label = moduleKeys.map((k) => modules[k]?.label ?? k).join(" / ");
                  const note = moduleNote(moduleKeys, modules);
                  return (
                    <fieldset key={id} className="mt-3 border-t border-line pt-2">
                      <legend className="pr-2 text-xs font-medium uppercase tracking-wide text-subtle">{label}</legend>
                      {note && <p className="mb-2 text-xs text-warning">{note}</p>}
                      <PermissionGrid entries={list} ticked={ticked} lockReason={lockReason} disabled={saving} onToggle={toggle} />
                    </fieldset>
                  );
                })}
              </fieldset>
            );
          })}
          {visibleGroups.length === 0 && (
            <p className="rounded-base bg-surface-sunken px-3 py-6 text-center text-sm text-subtle">
              No permission matches &ldquo;{search}&rdquo;.
            </p>
          )}
        </div>

        <div aria-live="polite" aria-atomic="true">
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
        </div>

        {/* Pinned to the bottom of the scrolling body, so Save is always in reach. */}
        <div className="sticky bottom-0 -mb-px border-t border-line bg-surface pt-3">
          {confirmDiscard ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <p role="alert" className="mr-auto text-sm text-text">
                Discard your changes to this role?
              </p>
              <Button ref={keepEditingRef} type="button" variant="secondary" size="sm" onClick={() => setConfirmDiscard(false)}>
                Keep editing
              </Button>
              <Button type="button" variant="danger" size="sm" onClick={onClose}>
                Discard
              </Button>
            </div>
          ) : (
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={requestClose} disabled={saving}>
                {readOnly ? "Close" : "Cancel"}
              </Button>
              {!readOnly && (
                <Button type="button" size="sm" onClick={save} disabled={saving || !dirty || name.trim().length < 2}>
                  {saving ? "Saving…" : "Save role"}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Checkboxes in two columns (one on a phone), each labelled by its permission. */
function PermissionGrid({
  entries,
  ticked,
  lockReason,
  disabled,
  onToggle,
}: {
  entries: CatalogueEntry[];
  ticked: Set<string>;
  lockReason: (entry: CatalogueEntry) => string | null;
  disabled: boolean;
  onToggle: (key: string, on: boolean) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {entries.map((entry) => {
        const reason = lockReason(entry);
        const tier = TIER_BADGE[entry.tier];
        return (
          <label
            key={entry.key}
            title={reason ?? entry.description}
            className={`flex items-start gap-2 text-sm ${reason ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--brand)]"
              checked={ticked.has(entry.key)}
              disabled={disabled || reason !== null}
              onChange={(e) => onToggle(entry.key, e.target.checked)}
              data-permission={entry.key}
            />
            <span className="min-w-0">
              <span className="text-text">{entry.label}</span>
              {tier && (
                <Badge tone={tier.tone} className="ml-1.5 align-middle">
                  {tier.label}
                </Badge>
              )}
              {entry.superAdminOnly && (
                <Badge tone="brand" className="ml-1.5 align-middle">
                  Super admin only
                </Badge>
              )}
              {reason && <span className="sr-only"> — {reason}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/**
 * The transformation the server does, so the field can show the key it is about to produce.
 * Duplicated rather than imported for the reason role-manager.tsx gives: the server's copy decides.
 */
function keyPreview(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 40);
}
