"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CreditCard, KeyRound, Pencil, Power } from "lucide-react";
import { sendPasswordResetEmail, setUserActive } from "@/actions/user";
import { issueDigitalCards } from "@/actions/card";
import { ResetLinkOnce } from "@/components/settings/setup-link-once";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { ActionNotice } from "@/components/ui/action-notice";
import { EditStaffDialog } from "@/components/settings/staff/edit-staff-dialog";
import type { DepartmentChoice, RoleChoice, StaffRow, WorkBranch } from "@/components/settings/staff/types";

/**
 * What can be done to one person's account from their page — what the Staff table's row did: edit their
 * profile (role, department, manager, branch, job title, phone), switch them off or on, send them a
 * password reset, and issue their digital card. Each through the action it always used, with its own checks.
 */
export function UserAccountActions({
  mode,
  row,
  roles,
  departments,
  people,
  branches,
  mayEdit,
  mayAssignRole,
  mayChangeManager,
  viewerIsSuperAdmin,
  showCards = false,
  editLabel = "Edit profile",
}: {
  mode: "profile" | "login";
  row: StaffRow;
  roles: RoleChoice[];
  departments: DepartmentChoice[];
  people: { id: string; name: string }[];
  branches: WorkBranch[] | null;
  /** `users.manage`. */
  mayEdit: boolean;
  mayAssignRole: boolean;
  mayChangeManager: boolean;
  viewerIsSuperAdmin: boolean;
  /** `cards.manage`, with Cards in the plan. */
  showCards?: boolean;
  editLabel?: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [switchingOff, setSwitchingOff] = useState(false);
  const [resetUrl, setResetUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  const canEdit = mayEdit && (!row.isSuperAdmin || viewerIsSuperAdmin);
  // Never yourself, and never the super admin: the database keeps exactly one.
  const canSwitch = mayEdit && !row.isYou && !row.isSuperAdmin;

  const setActive = (active: boolean) =>
    start(async () => {
      setNotice(null);
      const result = await setUserActive(row.id, active);
      setSwitchingOff(false);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setNotice({ tone: "success", text: active ? `${row.name} is switched on again.` : `${row.name} is switched off. Everything they own stays as it is.` });
      router.refresh();
    });

  /** A card for them — or their switched-off one back on — the same as Digital cards does it. */
  const issueCard = () =>
    start(async () => {
      setNotice(null);
      const result = await issueDigitalCards({ userIds: [row.id] });
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      setNotice({ tone: "success", text: row.card?.state === "off" ? `${row.name}'s digital card is switched back on.` : `${row.name} has a digital card now.` });
      router.refresh();
    });

  // One click: the email only offers a new password, and their current one keeps working until they use it.
  const sendReset = () =>
    start(async () => {
      setNotice(null);
      const result = await sendPasswordResetEmail(row.id);
      if (!result.ok) {
        setNotice({ tone: "error", text: result.error });
        return;
      }
      if (result.data.emailed) setNotice({ tone: "success", text: `Password reset email sent to ${row.email}. Their current password works until they use the link.` });
      else setResetUrl(result.data.resetUrl);
    });

  return (
    <div className="space-y-3">
      {mode === "login" && (row.tempPassword || showCards) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {row.tempPassword && (
            <Badge tone="amber" title="An admin reset their password; they choose their own at next sign-in.">
              Temporary password
            </Badge>
          )}
          {showCards &&
            (row.card?.state === "live" ? (
              <>
                <Badge tone="green">Digital card live</Badge>
                <a href={`/c/${row.card.handle}`} target="_blank" rel="noopener noreferrer" className="text-brand hover:underline">
                  /c/{row.card.handle}
                </a>
              </>
            ) : row.card?.state === "ended" ? (
              <Badge title="Their last working day has passed — the card shows the company's details.">Digital card ended</Badge>
            ) : row.card?.state === "off" ? (
              <Badge>Digital card off</Badge>
            ) : (
              <Badge>No digital card</Badge>
            ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {mode === "profile" && canEdit && (
          <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {editLabel}
          </Button>
        )}
        {mode === "login" && canSwitch && (
          <Button variant={row.active ? "secondary" : "primary"} size="sm" onClick={() => (row.active ? setSwitchingOff(true) : setActive(true))} disabled={pending}>
            <Power className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {row.active ? "Switch off" : "Switch on"}
          </Button>
        )}
        {mode === "login" && canEdit && row.active && !row.isYou && !row.setupPending && (
          <Button variant="secondary" size="sm" onClick={sendReset} disabled={pending}>
            <KeyRound className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Send password reset
          </Button>
        )}
        {mode === "login" && showCards && row.active && !row.setupPending && (row.card === null || row.card.state === "off") && (
          <Button variant="secondary" size="sm" onClick={issueCard} disabled={pending}>
            <CreditCard className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            {row.card?.state === "off" ? "Switch digital card on" : "Issue digital card"}
          </Button>
        )}
      </div>
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      {editing && (
        <EditStaffDialog
          key={row.id}
          row={row}
          onClose={() => setEditing(false)}
          roles={roles}
          departments={departments}
          people={people}
          branches={branches}
          mayAssignRole={mayAssignRole}
          mayChangeManager={mayChangeManager}
        />
      )}

      <Dialog open={switchingOff} onClose={() => setSwitchingOff(false)} title={`Switch off ${row.name}?`}>
        <div className="space-y-4">
          <p className="text-sm text-muted">They&apos;re signed out straight away and can&apos;t sign in until somebody switches them back on, and their seat is freed.</p>
          <p className="text-sm text-muted">
            Nothing is deleted. People own records, so accounts are never removed: their customers, leads, orders and history stay as they are, under their name.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setSwitchingOff(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={() => setActive(false)} disabled={pending}>
              {pending ? "Switching off…" : `Switch off ${row.name}`}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={resetUrl !== null} onClose={() => setResetUrl(null)} title="Password reset link">
        {resetUrl && <ResetLinkOnce email={row.email} resetUrl={resetUrl} onDone={() => setResetUrl(null)} />}
      </Dialog>
    </div>
  );
}
