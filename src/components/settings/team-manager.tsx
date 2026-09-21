"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Role } from "@prisma/client";
import { updateUserAssignment, setUserActive, resetUserTwoFactor } from "@/actions/user";
import { Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";

type TeamUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  twoFactorEnabledAt: Date | string | null;
  departmentId: string | null;
  managerId: string | null;
};

function TeamRow({
  user,
  users,
  departments,
  roles,
}: {
  user: TeamUser;
  users: TeamUser[];
  departments: { id: string; name: string }[];
  roles: readonly Role[];
}) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(user.role);
  const [departmentId, setDepartmentId] = useState(user.departmentId ?? "");
  const [managerId, setManagerId] = useState(user.managerId ?? "");
  const [isPending, startTransition] = useTransition();
  const [isTogglingActive, startActiveTransition] = useTransition();
  const [isResetting2fa, startResetTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmReset2fa, setConfirmReset2fa] = useState(false);

  const dirty = role !== user.role || departmentId !== (user.departmentId ?? "") || managerId !== (user.managerId ?? "");

  function handleSave() {
    setError(null);
    startTransition(async () => {
      const result = await updateUserAssignment({
        id: user.id,
        role,
        departmentId: departmentId || null,
        managerId: managerId || null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggleActive() {
    setError(null);
    startActiveTransition(async () => {
      const result = await setUserActive(user.id, !user.active);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function reset2fa() {
    setError(null);
    startResetTransition(async () => {
      const result = await resetUserTwoFactor(user.id);
      if (!result.ok) {
        setError(result.error);
        setConfirmReset2fa(false);
        return;
      }
      setConfirmReset2fa(false);
      router.refresh();
    });
  }

  const managerOptions = users.filter((u) => u.id !== user.id);

  return (
    <tr className="border-b border-line last:border-0">
      <td className="py-3 pr-4">
        <div className="font-medium text-text">{user.name}</div>
        <div className="text-muted">{user.email}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {!user.active && <Badge tone="amber">Inactive</Badge>}
          {user.mustChangePassword && <Badge tone="default">Temp password</Badge>}
        </div>
      </td>
      {/* One row per member, so the column header alone would name every row's control identically.
          The name carries the member it belongs to — an id/htmlFor pairing has nothing to point at
          here anyway, since the headers are `<th>` text rather than labels. */}
      <td className="py-3 pr-3">
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label={`Role for ${user.name}`}>
          {roles.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </Select>
      </td>
      <td className="py-3 pr-3">
        <Select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          aria-label={`Department for ${user.name}`}
        >
          <option value="">No department</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
      </td>
      <td className="py-3 pr-3">
        <Select
          value={managerId}
          onChange={(e) => setManagerId(e.target.value)}
          aria-label={`Manager for ${user.name}`}
        >
          <option value="">No manager</option>
          {managerOptions.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </td>
      <td className="py-3 pr-3">
        <div className="flex items-center gap-2">
          {user.twoFactorEnabledAt ? <Badge tone="green">2FA on</Badge> : <Badge tone="default">2FA off</Badge>}
          {user.twoFactorEnabledAt && (
            <button
              type="button"
              disabled={isResetting2fa}
              onClick={() => setConfirmReset2fa(true)}
              className="text-xs text-muted underline decoration-dotted hover:text-text disabled:opacity-40"
            >
              {isResetting2fa ? "Resetting…" : "Reset"}
            </button>
          )}
        </div>
        <Dialog open={confirmReset2fa} onClose={() => setConfirmReset2fa(false)} title="Reset two-factor authentication">
          <p className="text-sm text-muted">
            Reset two-factor authentication for <span className="font-medium text-text">{user.name}</span>?
            They&apos;ll need to set it up again from their profile before they can sign in again if two-factor is
            required.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmReset2fa(false)} disabled={isResetting2fa}>
              Cancel
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={reset2fa} disabled={isResetting2fa}>
              {isResetting2fa ? "Resetting…" : "Reset"}
            </Button>
          </div>
        </Dialog>
      </td>
      <td className="py-3 pr-3">
        <Button type="button" variant="ghost" size="sm" disabled={isTogglingActive} onClick={toggleActive}>
          {isTogglingActive ? "Saving…" : user.active ? "Deactivate" : "Activate"}
        </Button>
      </td>
      <td className="py-3">
        <button
          type="button"
          disabled={!dirty || isPending}
          onClick={handleSave}
          className="rounded-md bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand disabled:opacity-40"
        >
          {isPending ? "Saving…" : "Save"}
        </button>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
      </td>
    </tr>
  );
}

export function TeamManager({
  users,
  departments,
  roles,
}: {
  users: TeamUser[];
  departments: { id: string; name: string }[];
  roles: readonly Role[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
            <th className="py-2 pr-4">User</th>
            <th className="py-2 pr-3">Role</th>
            <th className="py-2 pr-3">Department</th>
            <th className="py-2 pr-3">Reporting manager</th>
            <th className="py-2 pr-3">Security</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <TeamRow key={user.id} user={user} users={users} departments={departments} roles={roles} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
