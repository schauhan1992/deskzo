"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Power, Search, Trash2 } from "lucide-react";
import { setUserActive } from "@/actions/user";
import { STAFF_STATUS_LABEL, type StaffStatus } from "@/lib/staff/status";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Select } from "@/components/ui/input";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { UserAccessDrawer } from "@/components/settings/user-access-drawer";
import { EditStaffDialog } from "@/components/settings/staff/edit-staff-dialog";
import type { DepartmentChoice, RoleChoice, StaffRow, WorkBranch } from "@/components/settings/staff/types";

/**
 * The Staff tab's table: who can sign in, in the reference layout — avatar and name, role, the leads
 * they hold, status, when they last signed in, and the row's actions.
 *
 * It also carries what the old People tab showed, so nothing an access review relied on went away:
 * how much of the catalogue each person holds and their personal exceptions (under the role), who
 * they report to, the same filters, and the effective-permissions drawer.
 *
 * The trash icon switches somebody off rather than deleting them. People own records — accounts,
 * leads, orders, the history of who approved what — so an account is never hard-deleted; switched
 * off, it signs in to nothing and takes no seat, and everything it owns stays where it is.
 */

const STATUS_TONE: Record<StaffStatus, "green" | "blue" | "default"> = {
  active: "green",
  invited: "blue",
  off: "default",
};

type Filter = "current" | "invited" | "exceptions" | "off" | "all";

export function StaffTable({
  rows,
  roles,
  departments,
  branches,
  mayEdit,
  mayAssignRole,
  mayManageAccess,
  viewerIsSuperAdmin,
  showLeads,
  showSignIns,
}: {
  rows: StaffRow[];
  roles: RoleChoice[];
  departments: DepartmentChoice[];
  /** The "Works at" choices, or null when the company has one branch or the viewer may not set it. */
  branches: WorkBranch[] | null;
  /** `users.manage`: edit, switch off and on, resend setup. */
  mayEdit: boolean;
  mayAssignRole: boolean;
  /** `permissions.manage`: change reporting lines, and grant exceptions in the access drawer. */
  mayManageAccess: boolean;
  viewerIsSuperAdmin: boolean;
  showLeads: boolean;
  showSignIns: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("");
  const [filter, setFilter] = useState<Filter>("current");
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [switchingOff, setSwitchingOff] = useState<StaffRow | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const roleChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.role, r.roleName);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const shown = rows.filter((r) => {
    const q = query.trim().toLowerCase();
    if (q && !`${r.name} ${r.email} ${r.jobTitle ?? ""}`.toLowerCase().includes(q)) return false;
    if (role && r.role !== role) return false;
    // Switched-off accounts are hidden by default rather than dropped: an access review has to be
    // able to find the account somebody left behind.
    if (filter === "current") return r.active;
    if (filter === "invited") return r.status === "invited";
    if (filter === "exceptions") return r.active && r.exceptions > 0;
    if (filter === "off") return !r.active;
    return true;
  });

  const people = rows.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  const canEdit = (r: StaffRow) => mayEdit && (!r.isSuperAdmin || viewerIsSuperAdmin);
  // Never yourself, and never the super admin: the database keeps exactly one, and they can't be
  // switched off from here (src/lib/authz/guards.ts).
  const canSwitchOff = (r: StaffRow) => mayEdit && r.active && !r.isYou && !r.isSuperAdmin;

  function setActive(r: StaffRow, active: boolean) {
    setNotice(null);
    startTransition(async () => {
      const result = await setUserActive(r.id, active);
      setSwitchingOff(null);
      if (!result.ok) {
        setNotice({ tone: "error", message: result.error });
        return;
      }
      setNotice({
        tone: "success",
        message: active ? `${r.name} is switched on again.` : `${r.name} is switched off. Everything they own stays as it is.`,
      });
      router.refresh();
    });
  }

  const columns = 4 + (showLeads ? 1 : 0) + (showSignIns ? 1 : 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, email or job title…"
            className="pl-8"
            aria-label="Search staff"
          />
        </div>
        <Select value={role} onChange={(e) => setRole(e.target.value)} className="w-full sm:w-44" aria-label="Filter by role">
          <option value="">All roles</option>
          {roleChoices.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </Select>
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          className="w-full sm:w-52"
          aria-label="Filter by status"
        >
          <option value="current">Everyone active or invited</option>
          <option value="invited">Invited, no password yet</option>
          <option value="exceptions">Only people with exceptions</option>
          <option value="off">Switched off</option>
          <option value="all">Everyone</option>
        </Select>
        <span className="text-sm text-subtle sm:ml-auto" aria-live="polite">
          {shown.length} of {rows.length}
        </span>
      </div>

      <ActionNoticeRegion notice={notice} className="px-5" />

      {/* Phones: the table keeps its columns and scrolls sideways inside the card. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-5 py-2.5 font-medium">
                Name
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                Role
              </th>
              {showLeads && (
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Leads
                </th>
              )}
              <th scope="col" className="px-4 py-2.5 font-medium">
                Status
              </th>
              {showSignIns && (
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Last signed in
                </th>
              )}
              <th scope="col" className="px-5 py-2.5 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <Avatar user={{ id: r.id, name: r.name, photoUpdatedAt: r.photoUpdatedAt }} size="md" />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-1.5">
                        <span className="font-medium text-text">{r.name}</span>
                        {r.isYou && <span className="text-xs text-muted">(you)</span>}
                      </div>
                      <div className="truncate text-xs text-muted">{r.email}</div>
                      {(r.jobTitle || r.departmentName) && (
                        <div className="truncate text-xs text-subtle">
                          {[r.jobTitle, r.departmentName].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 align-middle">
                  <Badge tone={r.isSuperAdmin ? "brand" : "default"}>{r.isSuperAdmin ? "Super admin" : r.roleName}</Badge>
                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-subtle">
                    {/* "Holds 47 of 108": the line an access review starts from. */}
                    <span className="tabular-nums">{r.isSuperAdmin ? "Holds everything" : `Holds ${r.holds} of ${r.total}`}</span>
                    {r.exceptions > 0 && (
                      <Badge tone={r.lapsingSoon ? "amber" : "default"}>
                        {r.exceptions} exception{r.exceptions === 1 ? "" : "s"}
                        {r.lapsingSoon ? " · ending soon" : ""}
                      </Badge>
                    )}
                    {r.managerName && <span>· reports to {r.managerName}</span>}
                  </div>
                </td>
                {showLeads && (
                  <td className="px-4 py-3 tabular-nums">
                    {r.overdueLeads ? (
                      <span
                        className="font-medium text-danger"
                        title={`${r.overdueLeads} of them past their expected close date`}
                      >
                        {r.openLeads}
                        <span className="sr-only">
                          {" "}
                          open, {r.overdueLeads} past their expected close date
                        </span>
                      </span>
                    ) : (
                      <span className={r.openLeads ? "text-text" : "text-subtle"}>{r.openLeads ?? 0}</span>
                    )}
                  </td>
                )}
                <td className="px-4 py-3">
                  <Badge tone={STATUS_TONE[r.status]}>{STAFF_STATUS_LABEL[r.status]}</Badge>
                </td>
                {showSignIns && (
                  <td className="whitespace-nowrap px-4 py-3 text-muted">
                    {r.lastSignIn ? (
                      <time dateTime={r.lastSignIn.iso} title={r.lastSignIn.exact}>
                        {r.lastSignIn.label}
                      </time>
                    ) : (
                      <span className="text-subtle">Never</span>
                    )}
                  </td>
                )}
                <td className="px-5 py-3">
                  <RowActions>
                    {canEdit(r) && (
                      <IconButton icon={Pencil} label={`Edit ${r.name}`} onClick={() => setEditing(r)} disabled={pending} />
                    )}
                    <UserAccessDrawer userId={r.id} userName={r.name} mayManage={mayManageAccess} />
                    {canSwitchOff(r) && (
                      <IconButton
                        icon={Trash2}
                        tone="danger"
                        label={`Switch off ${r.name}`}
                        onClick={() => setSwitchingOff(r)}
                        disabled={pending}
                      />
                    )}
                    {mayEdit && !r.active && (
                      <IconButton
                        icon={Power}
                        label={`Switch ${r.name} back on`}
                        onClick={() => setActive(r, true)}
                        disabled={pending}
                      />
                    )}
                  </RowActions>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns} className="px-5 py-10 text-center text-sm text-muted">
                  Nobody matches those filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditStaffDialog
          key={editing.id}
          row={editing}
          onClose={() => setEditing(null)}
          roles={roles}
          departments={departments}
          people={people}
          branches={branches}
          mayAssignRole={mayAssignRole}
          mayChangeManager={mayManageAccess}
        />
      )}

      <Dialog
        open={switchingOff !== null}
        onClose={() => setSwitchingOff(null)}
        title={switchingOff ? `Switch off ${switchingOff.name}?` : "Switch off"}
      >
        {switchingOff && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              They&apos;re signed out straight away and can&apos;t sign in until somebody switches them back on, and
              their seat is freed.
            </p>
            <p className="text-sm text-muted">
              Nothing is deleted. People own records, so accounts are never removed: their customers, leads, orders and
              history stay as they are, under their name. To pass their live work to colleagues, hand it over from their
              People record.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => setSwitchingOff(null)} disabled={pending}>
                Cancel
              </Button>
              <Button type="button" variant="danger" size="sm" onClick={() => setActive(switchingOff, false)} disabled={pending}>
                {pending ? "Switching off…" : `Switch off ${switchingOff.name}`}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
