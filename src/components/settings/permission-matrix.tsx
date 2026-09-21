"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Lock, ShieldAlert, Sparkles, RotateCcw, Search } from "lucide-react";
import type { Role } from "@prisma/client";
import { setRolePermission, resetRolePermission } from "@/actions/permission";
import type { previewPreset } from "@/actions/access";
import { applyPreset, previewPreset as loadPreview } from "@/actions/access";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { PERMISSION_GROUP_ORDER } from "@/lib/permissions";
import type { RolePreset } from "@/lib/authz/presets";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * The permission matrix.
 *
 * The version this replaces was a flat table of every key against every role. That works at 33 keys
 * and stops working well before 100 — which is where a registry ends up once it actually covers the
 * application. Three changes carry it:
 *
 *   - **Grouped and collapsible**, so somebody changing a finance permission reads twelve rows
 *     rather than a hundred.
 *   - **Searchable**, because at this size the fastest route to a row is typing its name.
 *   - **Presets first**, since the common task is "set this role up like an accounts manager" and
 *     doing that by hand is forty clicks nobody will get exactly right.
 *
 * The other change is honesty: a cell that cannot be toggled now says why — reserved to a super
 * admin, or not inheritable — rather than silently refusing. An admin who finds a switch dead and is
 * told nothing concludes the screen is broken.
 */

export type MatrixRow = {
  key: string;
  label: string;
  description: string;
  group: string;
  delegable: boolean;
  superAdminOnly: boolean;
  selfExcluded: boolean;
  tier: string;
  roles: Record<string, boolean>;
  /** Whether each role's answer is pinned by a stored row rather than taken from the registry. */
  explicit?: Record<string, boolean>;
};

/**
 * Allow, Deny, or neither — and "neither" is a real answer, not the absence of one.
 *
 * A two-state switch could say what a role can do and not why. The three states here are the three
 * states the data actually has:
 *
 *   · **Default** — no stored row. The registry decides, and the role moves if the registry does.
 *   · **Allow** — a stored row saying yes. Pinned; a registry change will not move it.
 *   · **Deny** — a stored row saying no. Also pinned, and the case a two-state switch could not
 *     express at all: "off" looked identical whether it had been decided or merely never set.
 *
 * The distinction is not academic. `applyPreset` pins every key by design, so after applying one,
 * an entire column is stored rather than inherited — and the old screen looked exactly the same
 * before and after.
 */
function Toggle({
  role,
  permissionKey,
  allowed,
  explicit,
  disabled,
  disabledReason,
}: {
  role: Role;
  permissionKey: string;
  allowed: boolean;
  explicit: boolean;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const state: "allow" | "deny" | "default" = !explicit ? "default" : allowed ? "allow" : "deny";

  /**
   * One control, cycling Default → Allow → Deny → Default.
   *
   * A radio group of three would be honest and would also be six hundred radios on one screen. A
   * cycling button keeps the grid readable; `aria-label` carries the current state and the next
   * one, so it is not a control you have to see to understand.
   */
  const NEXT = { default: "allow", allow: "deny", deny: "default" } as const;
  const next = NEXT[state];

  const STYLE = {
    allow: { box: "border-success/50 bg-success/10 text-success", mark: "✓", word: "Allow" },
    deny: { box: "border-danger/50 bg-danger/10 text-danger", mark: "✕", word: "Deny" },
    default: { box: "border-line bg-surface-sunken text-subtle", mark: allowed ? "·" : "·", word: "Default" },
  }[state];

  return (
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        aria-label={`${permissionKey} for ${role}: ${STYLE.word}${
          state === "default" ? ` (the registry says ${allowed ? "yes" : "no"})` : ""
        }. Activate to set it to ${NEXT[state] === "default" ? "Default" : NEXT[state] === "allow" ? "Allow" : "Deny"}.`}
        title={
          disabled
            ? disabledReason
            : state === "default"
              ? `Not set — the registry gives ${role} ${allowed ? "yes" : "no"}. Click to pin it.`
              : `${STYLE.word}, pinned. Click for ${next === "default" ? "Default" : next === "allow" ? "Allow" : "Deny"}.`
        }
        disabled={isPending || disabled}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            // Back to Default is a *removal* of the stored row, which is why it is a different
            // action rather than a third value on the same one.
            const result =
              next === "default"
                ? await resetRolePermission(role, permissionKey)
                : await setRolePermission(role, permissionKey, next === "allow");
            if (!result.ok) {
              setError(result.error);
              return;
            }
            router.refresh();
          });
        }}
        className={`flex h-6 w-10 shrink-0 items-center justify-center rounded-base border text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${STYLE.box}`}
      >
        {/* The glyph is decorative — the accessible name above carries the state. */}
        <span aria-hidden="true">{STYLE.mark}</span>
      </button>
      {error && <span className="max-w-32 text-center text-[11px] leading-tight text-danger">{error}</span>}
    </div>
  );
}

type Preview = Awaited<ReturnType<typeof previewPreset>>;

function PresetBar({
  presets,
  role,
  mayManage,
}: {
  presets: RolePreset[];
  role: Role;
  mayManage: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [confirming, setConfirming] = useState<RolePreset | null>(null);
  /**
   * What the preset will actually do, fetched before it does it.
   *
   * `previewPreset` has existed since presets were built and nothing called it. The panel said
   * "anything not in the preset is switched off" — true, and useless as a basis for a decision,
   * because it does not say what that turns out to be *for this role as it stands today*. "Applies
   * 40, takes away 12, and here are the twelve" is a sentence somebody can act on; the warning
   * alone is one they click past.
   */
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  if (presets.length === 0 || !mayManage) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-subtle">{role} presets</span>
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            title={p.description}
            disabled={isPending}
            onClick={() => {
              setConfirming(p);
              setPreview(null);
              setLoadingPreview(true);
              startTransition(async () => {
                const result = await loadPreview(p.key);
                setLoadingPreview(false);
                setPreview(result);
              });
            }}
            className="inline-flex items-center gap-1.5 rounded-full border border-line-strong px-3 py-1 text-xs font-medium text-muted hover:bg-surface-sunken hover:text-text disabled:opacity-40"
          >
            <Sparkles className="h-3 w-3" />
            {p.label}
          </button>
        ))}
      </div>

      {confirming && (
        <div className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          <p className="font-medium">Apply &ldquo;{confirming.label}&rdquo; to {role}?</p>
          <p className="mt-0.5">{confirming.description}</p>
          <p className="mt-1">
            This sets every permission for {role} explicitly — anything not in the preset is switched{" "}
            <strong>off</strong>, including changes made by hand.
          </p>

          {loadingPreview && <p className="mt-2 text-warning/80">Working out what would change…</p>}

          {preview && (
            <div className="mt-2 space-y-1.5 border-t border-warning/30 pt-2">
              <p className="font-medium">
                {preview.willGrant.length} to add, {preview.willRevoke.length} to take away,{" "}
                {preview.unchanged} unchanged.
              </p>

              {/**
               * The revoked are listed in full and the granted are counted.
               *
               * Not symmetry for its own sake: taking something away is what breaks somebody's
               * afternoon, and "12 revoked" is a number people accept without reading. Which twelve
               * is the question they would have asked if the screen had let them.
               */}
              {preview.willRevoke.length > 0 && (
                <div>
                  <p className="text-warning/80">Taken away:</p>
                  <ul className="mt-0.5 space-y-0.5">
                    {preview.willRevoke.map((key) => (
                      <li key={key} className="font-mono text-[11px]">
                        {key}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {preview.willGrant.length === 0 && preview.willRevoke.length === 0 && (
                <p className="text-warning/80">{role} already matches this preset — applying it changes nothing.</p>
              )}
            </div>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              disabled={isPending}
              onClick={() => {
                const preset = confirming;
                setConfirming(null);
                setPreview(null);
                startTransition(async () => {
                  const result = await applyPreset(preset.key);
                  /**
                   * A refusal used to render exactly like a success.
                   *
                   * Both went into one `notice` string shown in muted grey, so "You can't change
                   * permissions." looked like "Applied: 40 granted, 12 revoked." — and somebody who
                   * believes they have just rewritten a role's access has no reason to check. What
                   * they think they changed is who can read payroll.
                   */
                  setNotice(
                    result.ok
                      ? {
                          tone: "success",
                          message: `Applied "${preset.label}": ${result.data.granted} granted, ${result.data.revoked} revoked.`,
                        }
                      : { tone: "error", message: result.error },
                  );
                  if (result.ok) router.refresh();
                });
              }}
            >
              {isPending ? "Applying…" : "Apply preset"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirming(null);
                setPreview(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <ActionNoticeRegion notice={notice} />
    </div>
  );
}

export function PermissionMatrix({
  rows,
  roles,
  presetsByRole,
  viewerIsSuperAdmin,
  mayManage = true,
}: {
  rows: MatrixRow[];
  roles: Role[];
  presetsByRole: Record<string, RolePreset[]>;
  viewerIsSuperAdmin: boolean;
  /**
   * False for somebody holding `permissions.view` and not `permissions.manage`.
   *
   * Without it this screen offered an auditor roughly six hundred live-looking switches, every one
   * of which answered "You can't change permissions." A control you may not use should not look
   * like one you may.
   */
  mayManage?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [resetError, setResetError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (r) =>
        r.label.toLowerCase().includes(term) ||
        r.key.toLowerCase().includes(term) ||
        r.description.toLowerCase().includes(term),
    );
  }, [rows, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, MatrixRow[]>();
    for (const row of filtered) {
      const list = map.get(row.group) ?? [];
      list.push(row);
      map.set(row.group, list);
    }
    return PERMISSION_GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, rows: map.get(g)! }));
  }, [filtered]);

  return (
    <div className="space-y-4">
      {resetError && (
        <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{resetError}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          {/* A search box whose only on-screen wording is the placeholder, which is gone the moment
              anybody types — so the name is set here rather than paired with a label. */}
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find a permission…"
            className="h-8 w-64 pl-8 text-sm"
            aria-label="Find a permission"
          />
        </div>
        <span className="text-xs text-subtle">
          {filtered.length} of {rows.length} permissions
        </span>
      </div>

      {!viewerIsSuperAdmin && (
        <p className="flex items-start gap-2 rounded-md bg-info-bg px-3 py-2 text-sm text-info">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          The ADMIN column and the super-admin-only permissions are read-only for you. Only a super admin can change
          what admins can do — otherwise an admin could widen their own role and every other admin would inherit it.
        </p>
      )}

      <div className="space-y-3">
        {roles
          .filter((r) => presetsByRole[r]?.length)
          .map((role) => (
            <PresetBar key={role} role={role} presets={presetsByRole[role] ?? []} mayManage={mayManage} />
          ))}
      </div>

      {grouped.map(({ group, rows: groupRows }) => {
        const isCollapsed = collapsed.has(group);
        return (
          <Card key={group}>
            <CardHeader
              className="flex cursor-pointer items-center justify-between text-sm font-medium text-text"
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(group)) next.delete(group);
                  else next.add(group);
                  return next;
                })
              }
            >
              <span className="flex items-center gap-2">
                {isCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                {group}
              </span>
              <span className="text-xs font-normal text-subtle">{groupRows.length}</span>
            </CardHeader>
            {!isCollapsed && (
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                      <th className="py-2 pr-4">Permission</th>
                      {roles.map((role) => (
                        <th key={role} className="px-2 py-2 text-center font-medium">
                          {role}
                        </th>
                      ))}
                      <th className="w-10 px-2 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {groupRows.map((perm) => (
                      <tr key={perm.key} className="border-b border-line last:border-0 align-top">
                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-medium text-text">{perm.label}</span>
                            {perm.tier === "critical" && <Badge tone="red">Critical</Badge>}
                            {perm.tier === "sensitive" && <Badge tone="amber">Sensitive</Badge>}
                            {perm.superAdminOnly && (
                              <Badge tone="brand" title="Only a super admin can grant this, to anyone.">
                                Super admin only
                              </Badge>
                            )}
                            {!perm.delegable && (
                              <Badge
                                tone="default"
                                title="A manager does not inherit this from somebody who reports to them."
                              >
                                Not inherited
                              </Badge>
                            )}
                            {perm.selfExcluded && (
                              <Badge tone="default" title="The holder cannot use this on a record they raised.">
                                Not on own records
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 max-w-xl text-muted">{perm.description}</div>
                          <code className="mt-0.5 block font-mono text-[11px] text-subtle">{perm.key}</code>
                        </td>
                        {roles.map((role) => {
                          const locked =
                            !mayManage ||
                            (role === "ADMIN" && !viewerIsSuperAdmin) ||
                            (perm.superAdminOnly && !viewerIsSuperAdmin);
                          return (
                            <td key={role} className="px-2 py-3 text-center">
                              <Toggle
                                role={role}
                                permissionKey={perm.key}
                                allowed={perm.roles[role] ?? false}
                                explicit={perm.explicit?.[role] ?? false}
                                disabled={locked}
                                disabledReason={
                                  !mayManage
                                    ? "You can review access but not change it."
                                    : role === "ADMIN"
                                      ? "Only a super admin can change what admins can do."
                                      : "Only a super admin can grant this permission."
                                }
                              />
                            </td>
                          );
                        })}
                        <td className="px-2 py-3 text-center">
                          {mayManage && (
                          <button
                            type="button"
                            title="Return every role to this permission's default"
                            aria-label={`Reset ${perm.label} to defaults`}
                            className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-text"
                            onClick={() =>
                              startTransition(async () => {
                                /**
                                 * Eight results, and every one used to be discarded before the
                                 * refresh — so a reset the server refused looked identical to one
                                 * it accepted. The first refusal is now reported.
                                 */
                                let refusal: string | null = null;
                                for (const role of roles) {
                                  if (role === "ADMIN" && !viewerIsSuperAdmin) continue;
                                  const result = await resetRolePermission(role, perm.key);
                                  if (!result.ok && !refusal) refusal = result.error;
                                }
                                setResetError(refusal);
                                router.refresh();
                              })
                            }
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            )}
          </Card>
        );
      })}

      {grouped.length === 0 && (
        <p className="flex items-center gap-2 rounded-md bg-surface-sunken px-3 py-6 text-sm text-subtle">
          <ShieldAlert className="h-4 w-4" />
          Nothing matches &ldquo;{search}&rdquo;.
        </p>
      )}
    </div>
  );
}
