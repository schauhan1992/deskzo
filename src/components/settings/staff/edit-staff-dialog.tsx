"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { resendSetupEmail, resetPasswordToTemporary, resetUserTwoFactor, sendPasswordResetEmail, updateUserAssignment } from "@/actions/user";
import { setUserBranch } from "@/actions/branch";
import { branchLabel } from "@/lib/branches/format";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { ResetLinkOnce, SetupLinkOnce, TemporaryPasswordOnce } from "@/components/settings/setup-link-once";
import type { DepartmentChoice, RoleChoice, StaffRow, WorkBranch } from "@/components/settings/staff/types";
import { PersonSignInRule } from "@/components/settings/staff/person-sign-in-rule";

/**
 * The pencil on a Staff row: what the old team table edited in a row of its own — role, department,
 * reporting manager, where they work, two-factor and the setup email — in one dialog, with their
 * password: a reset email, or a temporary password shown once.
 *
 * Every change goes through the action it always did (`updateUserAssignment`, `setUserBranch`,
 * `resetUserTwoFactor`, `resendSetupEmail`, `sendPasswordResetEmail`, `resetPasswordToTemporary`), so
 * every rule they enforce still applies. The fields the viewer can't change are shown disabled with the
 * reason, rather than offered and then refused.
 */
export function EditStaffDialog({
  row,
  onClose,
  roles,
  departments,
  people,
  branches,
  mayAssignRole,
  mayChangeManager,
}: {
  row: StaffRow;
  onClose: () => void;
  roles: RoleChoice[];
  departments: DepartmentChoice[];
  /** Everybody who could be their manager. */
  people: { id: string; name: string }[];
  branches: WorkBranch[] | null;
  /** `users.assignRole` — reserved to a super admin. */
  mayAssignRole: boolean;
  /** `permissions.manage` — a reporting line confers the reports' access on the manager. */
  mayChangeManager: boolean;
}) {
  const router = useRouter();
  const [role, setRole] = useState(row.role);
  const [departmentId, setDepartmentId] = useState(row.departmentId ?? "");
  const [managerId, setManagerId] = useState(row.managerId ?? "");
  const [branchId, setBranchId] = useState(row.branchId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [working, startWork] = useTransition();
  const [confirmReset, setConfirmReset] = useState(false);
  // The link to pass on when the setup email couldn't be sent — held only while this is open.
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [confirmPassword, setConfirmPassword] = useState(false);
  // Shown once and held only while this is open: the temporary password, or the reset link whose email failed.
  const [temporary, setTemporary] = useState<string | null>(null);
  const [resetUrl, setResetUrl] = useState<string | null>(null);

  const assignmentDirty =
    role !== row.role || departmentId !== (row.departmentId ?? "") || managerId !== (row.managerId ?? "");
  const branchDirty = branches !== null && branchId !== (row.branchId ?? "");
  const dirty = assignmentDirty || branchDirty;

  const roleLocked = !mayAssignRole || row.isYou;
  const roleHint = row.isYou
    ? "You can't change your own role. Ask another admin."
    : !mayAssignRole
      ? "Only a super admin can change somebody's role."
      : "Decides what they can do.";

  function save() {
    setError(null);
    startSave(async () => {
      if (assignmentDirty) {
        const result = await updateUserAssignment({
          id: row.id,
          role,
          departmentId: departmentId || null,
          managerId: managerId || null,
        });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      if (branchDirty) {
        const result = await setUserBranch(row.id, branchId || null);
        if (!result.ok) {
          setError(assignmentDirty ? `Saved, except where they work: ${result.error}` : result.error);
          router.refresh();
          return;
        }
      }
      router.refresh();
      onClose();
    });
  }

  function resetTwoFactor() {
    setError(null);
    startWork(async () => {
      const result = await resetUserTwoFactor(row.id);
      setConfirmReset(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone("Two-factor is reset. They'll set it up again from their profile.");
      router.refresh();
    });
  }

  /** One click: a link to their own address. Their current password works until they use it. */
  function sendResetEmail() {
    setError(null);
    setDone(null);
    startWork(async () => {
      const result = await sendPasswordResetEmail(row.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.emailed) setDone(`Sent to ${row.email}. Their current password works until they use the link.`);
      else setResetUrl(result.data.resetUrl);
    });
  }

  function resetPassword() {
    setError(null);
    setDone(null);
    startWork(async () => {
      const result = await resetPasswordToTemporary(row.id);
      setConfirmPassword(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTemporary(result.data.password);
      router.refresh();
    });
  }

  function resendSetup() {
    setError(null);
    setDone(null);
    startWork(async () => {
      const result = await resendSetupEmail(row.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.data.emailed) setDone("Sent. The earlier link no longer works.");
      else if (result.data.setupUrl) setSetupUrl(result.data.setupUrl);
      router.refresh();
    });
  }

  const managerOptions = people.filter((p) => p.id !== row.id);
  const idFor = (field: string) => `staff-${row.id}-${field}`;

  return (
    <Dialog open onClose={onClose} title={`Edit ${row.name}`} large>
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <Avatar user={{ id: row.id, name: row.name, photoUpdatedAt: row.photoUpdatedAt }} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text">{row.name}</p>
            <p className="truncate text-xs text-muted">
              {[row.email, row.jobTitle, row.phone].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={idFor("role")}>Role</Label>
            <Select
              id={idFor("role")}
              value={role}
              onChange={(e) => setRole(e.target.value)}
              disabled={roleLocked}
              aria-describedby={idFor("role-hint")}
            >
              {/* The role they hold stays listed even when the list no longer offers it. */}
              {!roles.some((r) => r.key === row.role) && <option value={row.role}>{row.roleName}</option>}
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </Select>
            <p id={idFor("role-hint")} className="text-xs text-subtle">
              {roleHint}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={idFor("department")}>Department</Label>
            <Select id={idFor("department")} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">No department</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">Grouping only — a department carries no permissions.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={idFor("manager")}>Reporting manager</Label>
            <Select
              id={idFor("manager")}
              value={managerId}
              onChange={(e) => setManagerId(e.target.value)}
              disabled={!mayChangeManager}
              aria-describedby={idFor("manager-hint")}
            >
              <option value="">No manager</option>
              {managerOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p id={idFor("manager-hint")} className="text-xs text-subtle">
              {mayChangeManager
                ? "Their manager also gets every permission they hold."
                : "A reporting line passes their permissions to their manager, so changing it needs permission to manage access."}
            </p>
          </div>

          {branches && (
            <div className="space-y-1.5">
              <Label htmlFor={idFor("branch")}>Works at</Label>
              <Select
                id={idFor("branch")}
                value={branchId}
                onChange={(e) => setBranchId(e.target.value)}
                aria-describedby={idFor("branch-hint")}
              >
                <option value="">— none —</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {`${branchLabel(b)}${b.active ? "" : " (inactive)"}`}
                  </option>
                ))}
              </Select>
              <p id={idFor("branch-hint")} className="text-xs text-subtle">
                Their default branch on new documents, and the state professional tax is worked out for.
              </p>
            </div>
          )}
        </div>

        {/* Only for whoever may change how people sign in — it renders nothing for anybody else. */}
        <PersonSignInRule userId={row.id} name={row.name} />

        <div className="space-y-3 rounded-base border border-line px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm text-text">
              Two-factor
              {row.twoFactorOn ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
            </div>
            {row.twoFactorOn && !confirmReset && (
              <Button type="button" variant="secondary" size="sm" disabled={working} onClick={() => setConfirmReset(true)}>
                Reset two-factor
              </Button>
            )}
          </div>
          {confirmReset && (
            <div className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              <p>
                Reset two-factor for <strong>{row.name}</strong>? They&apos;ll set it up again from their profile before
                they can sign in, if two-factor is required.
              </p>
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset(false)} disabled={working}>
                  Cancel
                </Button>
                <Button type="button" variant="danger" size="sm" onClick={resetTwoFactor} disabled={working}>
                  {working ? "Resetting…" : "Reset"}
                </Button>
              </div>
            </div>
          )}

          {!row.setupPending && !row.isYou && row.active && (
            <div className="space-y-2 border-t border-line pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-sm text-text">
                  Password
                  {row.tempPassword && (
                    <Badge tone="amber" title="They choose their own when they next sign in.">
                      Temporary
                    </Badge>
                  )}
                </div>
                {!confirmPassword && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="secondary" size="sm" disabled={working} onClick={sendResetEmail}>
                      {working ? "Working…" : "Send reset email"}
                    </Button>
                    <Button type="button" variant="secondary" size="sm" disabled={working} onClick={() => setConfirmPassword(true)}>
                      Reset password
                    </Button>
                  </div>
                )}
              </div>
              {confirmPassword && (
                <div className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                  <p>
                    Reset <strong>{row.name}</strong>&apos;s password? They&apos;re signed out everywhere at once, and you get a
                    temporary password to give them. They choose their own when they next sign in; two-factor stays on.
                  </p>
                  <div className="mt-2 flex justify-end gap-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmPassword(false)} disabled={working}>
                      Cancel
                    </Button>
                    <Button type="button" variant="danger" size="sm" onClick={resetPassword} disabled={working}>
                      {working ? "Resetting…" : "Reset password"}
                    </Button>
                  </div>
                </div>
              )}
              {temporary && <TemporaryPasswordOnce name={row.name} password={temporary} onDone={() => setTemporary(null)} />}
              {resetUrl && <ResetLinkOnce email={row.email} resetUrl={resetUrl} onDone={() => setResetUrl(null)} />}
            </div>
          )}

          {row.setupPending && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
              <div className="flex items-center gap-2 text-sm text-text">
                Setup
                <Badge tone="blue">Invited — no password yet</Badge>
              </div>
              {row.active ? (
                <Button type="button" variant="secondary" size="sm" disabled={working} onClick={resendSetup}>
                  {working ? "Sending…" : row.setupLinkIssued ? "Resend setup email" : "Send setup email"}
                </Button>
              ) : (
                <span className="text-xs text-subtle">Switch them on to send their setup email.</span>
              )}
            </div>
          )}
          {setupUrl && <SetupLinkOnce email={row.email} setupUrl={setupUrl} onDone={() => setSetupUrl(null)} />}
        </div>

        <div aria-live="polite" aria-atomic="true">
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
          {!error && done && <ActionNotice tone="success">{done}</ActionNotice>}
        </div>

        <div className="sticky bottom-0 -mb-px flex justify-end gap-2 border-t border-line bg-surface pt-3">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
