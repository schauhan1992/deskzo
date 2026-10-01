"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Columns3, Eye, MoreHorizontal, Pencil, Plus, ShieldCheck } from "lucide-react";
import { deleteRole } from "@/actions/role";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Menu, MenuItem } from "@/components/ui/menu";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";
import { RoleDialog, type RoleDialogProps } from "@/components/settings/staff/role-dialog";
import type { RoleCard } from "@/components/settings/staff/types";

/**
 * The Roles & permissions tab: one bordered card per role, in the reference layout — a shield, the
 * name, how many permissions it grants and what it is for, how many people hold it, whether it is
 * built in, and a pencil that opens the role dialog.
 *
 * The super admin comes first, as a card of its own with no pencil. It is not a role — it is one
 * account (src/lib/authz/resolve.ts answers for it before reading any of this) — but "who holds
 * everything" is the first thing anybody reading this tab wants to know, so it is shown where they
 * look. Admin's count leaves the super admin out, so the counts add up to the Staff tab's.
 *
 * Delete stays where it was only offered when it could succeed — a custom role nobody holds — now in
 * the row's "⋯".
 */
export function RolesPanel({
  roles,
  superAdminStaff,
  compareHref,
  dialog,
}: {
  roles: RoleCard[];
  /** Active super admins — there is exactly one — or null when there is none to show. */
  superAdminStaff: number | null;
  /** The matrix, kept for comparing roles side by side. */
  compareHref: string;
  /** Everything the role dialog needs apart from the role and closing it. */
  dialog: Omit<RoleDialogProps, "role" | "onClose">;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<{ role: RoleCard | null } | null>(null);
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const { mayManage } = dialog;

  function remove(role: RoleCard) {
    setNotice(null);
    startTransition(async () => {
      const result = await deleteRole(role.key);
      setNotice(result.ok ? { tone: "success", message: `Deleted "${role.name}".` } : { tone: "error", message: result.error });
      if (result.ok) router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-text">Roles and permissions</h2>
          <p className="mt-0.5 text-xs text-muted">Every action in this workspace is checked against these on the server.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={compareHref}
            className="inline-flex h-8 items-center gap-1.5 rounded-base px-3 text-[13px] font-medium text-muted transition-colors hover:bg-surface-sunken hover:text-text"
          >
            <Columns3 className="h-3.5 w-3.5" aria-hidden />
            Compare roles
          </Link>
          {mayManage && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen({ role: null })} disabled={pending}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              New role
            </Button>
          )}
        </div>
      </CardHeader>

      <div className="space-y-3 px-5 py-4">
        <ActionNoticeRegion notice={notice} />

        <ul className="space-y-3">
          {superAdminStaff !== null && (
            <li className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
              <RoleShield />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">Super admin</p>
                <p className="mt-0.5 text-xs text-muted">Every permission · Unrestricted access to every part of the workspace.</p>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge>{staffLabel(superAdminStaff)}</Badge>
                <Badge tone="blue">Built in</Badge>
                {/* No pencil: nothing on this screen applies to the super admin, so there is nothing to edit. */}
                <span className="inline-block w-7" aria-hidden />
              </div>
            </li>
          )}

          {roles.map((role) => {
            const count = role.held.length;
            const deletable = mayManage && !role.isSystem && role.headcount === 0;
            const summary = `${count} permission${count === 1 ? "" : "s"}`;
            return (
              <li key={role.key} className="flex flex-wrap items-center gap-3 rounded-xl border border-line px-4 py-3">
                <RoleShield />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-text">{role.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{[summary, role.description].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge title={role.headcount > role.activeStaff ? `${role.headcount - role.activeStaff} more switched off` : undefined}>
                    {staffLabel(role.activeStaff)}
                  </Badge>
                  {role.isSystem && (
                    <Badge
                      tone="blue"
                      title="Built in: rename it and change what it grants freely. It can't be deleted, because the application names it by key."
                    >
                      Built in
                    </Badge>
                  )}
                  <RowActions>
                    <IconButton
                      icon={mayManage ? Pencil : Eye}
                      label={mayManage ? `Edit role ${role.name}` : `View role ${role.name}`}
                      onClick={() => setOpen({ role })}
                      disabled={pending}
                    />
                    {deletable ? (
                      <Menu icon={MoreHorizontal} label={`More actions for ${role.name}`} width={200}>
                        {(close) => (
                          <MenuItem
                            danger
                            disabled={pending}
                            onClick={() => {
                              close();
                              remove(role);
                            }}
                          >
                            Delete role
                          </MenuItem>
                        )}
                      </Menu>
                    ) : (
                      <span className="inline-block w-7" aria-hidden />
                    )}
                  </RowActions>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {open && <RoleDialog key={open.role?.key ?? "new"} role={open.role} {...dialog} onClose={() => setOpen(null)} />}
    </Card>
  );
}

function RoleShield() {
  return (
    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand" aria-hidden>
      <ShieldCheck className="h-4 w-4" />
    </span>
  );
}

function staffLabel(n: number): string {
  return `${n} staff`;
}
