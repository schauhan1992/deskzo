"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, MonitorSmartphone } from "lucide-react";
import { consoleDeactivateStaff, consoleEndStaffSessions, consoleNewSetupLink, consoleResetStaffTwoFactor, consoleSetStaffRole } from "@/actions/platform/console";
import type { ConsoleResult } from "@/actions/platform/console";
import { consoleEndStaffSession, consoleReactivateStaff } from "@/actions/platform/console-admin";
import { DeviceIcon } from "@/components/console/account/sessions-table";
import { ConfirmBody, ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { LabelPill, RolePill, StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { RoleCards } from "@/components/console/staff/add-staff-dialog";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SidePane } from "@/components/ui/side-pane";
import { plural, when } from "@/lib/console-shared/format";
import { ROLE_LABEL, STAFF_STATE, twoFactorLabel } from "@/lib/console-shared/labels";
import { ROLE_DESCRIPTIONS } from "@/lib/console-shared/roles";
import type { ConsoleRole } from "@/lib/console-shared/types";
import type { StaffRow, StaffSessionView } from "@/lib/platform/staff";
import { cn } from "@/lib/utils";

/**
 * The staff list (spec §3.16): who can sign in, their role, whether their authenticator is set up,
 * when they last signed in and how many sessions they have open right now — a count that opens those
 * sessions in a side pane (the address each came from is there for owners only; the page drops it for
 * everybody else before it reaches the browser).
 *
 * Owners get a menu on every row but their own: change the role (T2, with what the new role may do),
 * sign out everywhere, reset two-factor, a new password link (shown once, in its dialog, never in the
 * table), switch off — and switch back on for somebody switched off. Every one of them is checked
 * again on the server; the last active owner can be neither demoted nor switched off, and that
 * refusal is shown in the dialog that asked.
 */

type Pending =
  | { kind: "role"; row: StaffRow }
  | { kind: "sign-out"; row: StaffRow }
  | { kind: "two-factor"; row: StaffRow }
  | { kind: "switch-off"; row: StaffRow }
  | { kind: "link"; row: StaffRow }
  | { kind: "switch-on"; row: StaffRow }
  | { kind: "session"; row: StaffRow; session: StaffSessionView };

type Policy = "required" | "off";

/** "becomes Admin — holds, reopens and migrates workspaces; …" — the role's own line, mid-sentence. */
function consequence(name: string, role: ConsoleRole): string {
  const line = ROLE_DESCRIPTIONS[role];
  return `${name} becomes ${ROLE_LABEL[role].label} — ${line.charAt(0).toLowerCase()}${line.slice(1)} Takes effect on their next request.`;
}

export function StaffTable({ rows, sessions, me, owner, policy }: { rows: StaffRow[]; sessions: StaffSessionView[]; me: string; owner: boolean; policy: Policy }) {
  const [paneFor, setPaneFor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const paneRow = paneFor ? (rows.find((r) => r.id === paneFor) ?? null) : null;
  const paneSessions = paneRow ? sessions.filter((s) => s.userId === paneRow.id) : [];

  function ask(next: Pending) {
    // One modal at a time: a confirmation opened from the sessions pane replaces it rather than
    // stacking over it, and the pane comes back when the confirmation closes.
    setPaneFor(null);
    setPending(next);
  }

  function closeDialog() {
    if (pending?.kind === "session") setPaneFor(pending.row.id);
    setPending(null);
  }

  function menuFor(row: StaffRow): RowMenuItem[] {
    if (!row.active) return [{ key: "switch-on", label: "Switch back on…", onSelect: () => ask({ kind: "switch-on", row }) }];
    return [
      { key: "role", label: "Change role…", onSelect: () => ask({ kind: "role", row }) },
      { key: "access", separator: true },
      ...(row.liveSessions > 0 ? [{ key: "sign-out", label: "Sign out everywhere", onSelect: () => ask({ kind: "sign-out", row }) }] : []),
      ...(row.totpEnabledAt ? [{ key: "two-factor", label: "Reset two-factor…", onSelect: () => ask({ kind: "two-factor", row }) }] : []),
      { key: "link", label: "New password link…", onSelect: () => ask({ kind: "link", row }) },
      { key: "end", separator: true },
      { key: "switch-off", label: "Switch off…", danger: true, onSelect: () => ask({ kind: "switch-off", row }) },
    ];
  }

  return (
    <>
      <DataTable caption="Staff" minWidth={owner ? 920 : 880}>
        <THead>
          <Th>Member</Th>
          <Th>Role</Th>
          <Th>Two-factor</Th>
          <Th>Last sign-in</Th>
          <Th>Signed in now</Th>
          <Th>Status</Th>
          {owner && <Th srOnly>Actions</Th>}
        </THead>
        <TBody>
          {rows.map((row) => {
            const self = row.id === me;
            const factor = twoFactorLabel(row.totpEnabledAt, policy === "required");
            return (
              <Tr key={row.id}>
                <Td>
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar user={{ id: row.id, name: row.name }} size="sm" className={cn(!row.active && "bg-surface-sunken text-subtle")} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("truncate font-medium", row.active ? "text-text" : "text-muted")}>{row.name}</span>
                        {self && <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[11px] leading-4 font-medium text-muted">you</span>}
                      </div>
                      <p className="max-w-[18rem] truncate text-xs text-muted" title={row.email}>
                        {row.email}
                      </p>
                    </div>
                  </div>
                </Td>
                <Td nowrap>
                  <RolePill role={row.role} />
                </Td>
                <Td nowrap>
                  <StatusPill tone={factor.tone} title={row.totpEnabledAt ? `Authenticator set up ${when(row.totpEnabledAt)}` : undefined}>
                    {factor.label}
                  </StatusPill>
                </Td>
                <Td muted nowrap>
                  {row.lastSignInAt ? <RelativeTime at={row.lastSignInAt} /> : <span className="text-subtle">Never</span>}
                </Td>
                <Td nowrap>
                  {row.liveSessions > 0 ? (
                    <button
                      type="button"
                      onClick={() => setPaneFor(row.id)}
                      aria-label={`${plural(row.liveSessions, "session")} — show ${self ? "yours" : `${row.name}'s`}`}
                      className="-mx-1.5 inline-flex items-center gap-1.5 rounded-base px-1.5 py-0.5 text-sm font-medium text-brand hover:bg-surface-sunken"
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
                      <span className="tabular-nums">{plural(row.liveSessions, "session")}</span>
                    </button>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </Td>
                <Td nowrap>
                  <LabelPill map={STAFF_STATE} value={row.active ? "active" : "off"} />
                </Td>
                {owner && <RowActionsCell>{!self && <RowMenu label={`Actions for ${row.name}`} items={menuFor(row)} />}</RowActionsCell>}
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      <SidePane open={paneRow !== null} onClose={() => setPaneFor(null)} title={paneRow ? `Sessions · ${paneRow.name}` : "Sessions"}>
        {paneRow && (
          <SessionsList
            row={paneRow}
            sessions={paneSessions}
            self={paneRow.id === me}
            owner={owner}
            policy={policy}
            onEnd={(session) => ask({ kind: "session", row: paneRow, session })}
          />
        )}
      </SidePane>

      {/* Each dialog is mounted only while it is open, so it starts without the last one's refusal. */}
      {owner && pending && <PendingDialog key={`${pending.kind}-${pending.row.id}`} pending={pending} onClose={closeDialog} />}
    </>
  );
}

/** A staff member's live sessions, most recently used first, for the side pane. */
function SessionsList({
  row,
  sessions,
  self,
  owner,
  policy,
  onEnd,
}: {
  row: StaffRow;
  sessions: StaffSessionView[];
  self: boolean;
  owner: boolean;
  policy: Policy;
  onEnd: (session: StaffSessionView) => void;
}) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">
        {sessions.length === 0
          ? `${row.name} is not signed in anywhere now.`
          : `Signed in on ${plural(sessions.length, "device")}. A session ends after 30 minutes without use, or 12 hours after signing in.`}
      </p>
      {self && (
        <Link href="/account" className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
          Manage your own sessions in My account
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      )}
      {sessions.length === 0 ? (
        <div className="grid place-items-center rounded-lg border border-dashed border-line px-4 py-8 text-center">
          <MonitorSmartphone aria-hidden="true" className="h-5 w-5 text-subtle" />
          <p className="mt-2 text-sm text-muted">No live sessions</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {sessions.map((s) => (
            <li key={s.id} className="rounded-lg border border-line bg-surface px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
                    <DeviceIcon device={s.device} />
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-text">{s.device}</p>
                    <p className="text-xs text-muted">
                      Last seen <RelativeTime at={s.lastSeenAt} />
                    </p>
                  </div>
                </div>
                {owner && !self && (
                  <Button type="button" variant="secondary" size="sm" onClick={() => onEnd(s)} aria-label={`Sign out ${row.name} on ${s.device}`}>
                    Sign out
                  </Button>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
                <SessionFact term="Signed in">
                  <RelativeTime at={s.createdAt} />
                </SessionFact>
                <SessionFact term="Expires">
                  <RelativeTime at={s.expiresAt} />
                </SessionFact>
                <SessionFact term="Two-factor">
                  {s.mfa ? (
                    <span className="text-success">Passed</span>
                  ) : (
                    <span className={policy === "required" ? "text-warning" : "text-muted"}>{policy === "required" ? "Not yet" : "Not asked"}</span>
                  )}
                </SessionFact>
                {owner && s.ip && (
                  <SessionFact term="IP address">
                    <span className="font-mono">{s.ip}</span>
                  </SessionFact>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SessionFact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{term}</dt>
      <dd className="mt-0.5 break-words text-text">{children}</dd>
    </div>
  );
}

/** Whichever confirmation the menu (or the pane) asked for. */
function PendingDialog({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  switch (pending.kind) {
    case "role":
      return <ChangeRoleDialog row={pending.row} onClose={onClose} />;
    case "link":
    case "switch-on":
      return <PasswordLinkDialog row={pending.row} mode={pending.kind} onClose={onClose} />;
    default:
      return <RowConfirmDialog pending={pending} onClose={onClose} />;
  }
}

/** Change role… (T2): the new role as radio cards, what it may do, and when it takes effect. */
function ChangeRoleDialog({ row, onClose }: { row: StaffRow; onClose: () => void }) {
  const action = useConsoleAction<unknown>();
  const [role, setRole] = useState<ConsoleRole>(row.role);
  const changed = role !== row.role;
  const close = () => {
    if (!action.pending) onClose();
  };

  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Change role"
      confirmLabel="Change role"
      pending={action.pending}
      error={action.error}
      confirmDisabled={!changed}
      onConfirm={() =>
        action.run(() => consoleSetStaffRole(row.id, role), { success: `${row.name} is now ${ROLE_LABEL[role].label}.`, onDone: onClose })
      }
    >
      <RoleCards
        legend={`${row.name}'s role`}
        value={role}
        current={row.role}
        disabled={action.pending}
        onChange={(next) => {
          setRole(next);
          action.reset();
        }}
      />
      {changed && (
        <>
          <p>{consequence(row.name, role)}</p>
          <ImpactList
            items={[
              { label: "Role", value: `${ROLE_LABEL[row.role].label} → ${ROLE_LABEL[role].label}`, tone: "brand" },
              { label: "Signed in now", value: row.liveSessions > 0 ? `${plural(row.liveSessions, "session")}, kept` : "Nowhere" },
            ]}
          />
        </>
      )}
    </ConfirmDialog>
  );
}

type Spec = { title: string; confirmLabel: string; tone: "primary" | "danger"; body: ReactNode; run: () => Promise<ConsoleResult<unknown>>; success: string };

/** The T1 confirmations: what each does to whom, in one sentence, and the verb. */
function specFor(pending: Exclude<Pending, { kind: "role" | "link" | "switch-on" }>): Spec {
  const { row } = pending;
  const name = <strong className="font-medium">{row.name}</strong>;
  switch (pending.kind) {
    case "sign-out":
      return {
        title: "Sign out everywhere",
        confirmLabel: "Sign out everywhere",
        tone: "primary",
        body: (
          <p>
            {name} is signed out of the console on every device ({plural(row.liveSessions, "session")}). They can sign in again straight away.
          </p>
        ),
        run: () => consoleEndStaffSessions(row.id),
        success: `${row.name} is signed out everywhere.`,
      };
    case "two-factor":
      return {
        title: "Reset two-factor",
        confirmLabel: "Reset two-factor",
        tone: "danger",
        body: (
          <p>
            {name}&apos;s authenticator is forgotten and they are signed out everywhere. At their next sign-in they set up a new one — for a lost or replaced phone.
          </p>
        ),
        run: () => consoleResetStaffTwoFactor(row.id),
        success: `Two-factor reset — ${row.name} sets up a new authenticator at their next sign-in.`,
      };
    case "switch-off":
      return {
        title: "Switch off",
        confirmLabel: "Switch off",
        tone: "danger",
        body: (
          <p>
            {name} is signed out everywhere and can no longer sign in. Their account and its history stay, and an owner can switch them back on.
          </p>
        ),
        run: () => consoleDeactivateStaff(row.id),
        success: `${row.name} is switched off.`,
      };
    case "session":
      return {
        title: "Sign out session",
        confirmLabel: "Sign out",
        tone: "primary",
        body: (
          <p>
            {name}&apos;s session on <strong className="font-medium">{pending.session.device}</strong>, last used {when(pending.session.lastSeenAt)}, ends now. Their
            other sessions stay signed in.
          </p>
        ),
        run: () => consoleEndStaffSession(pending.session.id),
        success: `Signed ${row.name} out of ${pending.session.device}.`,
      };
  }
}

function RowConfirmDialog({ pending, onClose }: { pending: Exclude<Pending, { kind: "role" | "link" | "switch-on" }>; onClose: () => void }) {
  const action = useConsoleAction<unknown>();
  const spec = specFor(pending);
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title={spec.title}
      confirmLabel={spec.confirmLabel}
      tone={spec.tone}
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(spec.run, { success: spec.success, onDone: onClose })}
    >
      {spec.body}
    </ConfirmDialog>
  );
}

/**
 * New password link… and Switch back on… (T1, then the link): both end in a one-time link to choose
 * a password, shown once inside this dialog and gone when it closes. Switching back on also emails
 * it; a new link for somebody still on is only shown here, for the owner to pass on.
 */
function PasswordLinkDialog({ row, mode, onClose }: { row: StaffRow; mode: "link" | "switch-on"; onClose: () => void }) {
  const action = useConsoleAction<string>();
  const [url, setUrl] = useState<string | null>(null);
  const close = () => {
    if (!action.pending) onClose();
  };
  const name = <strong className="font-medium">{row.name}</strong>;

  function confirm() {
    if (mode === "link") {
      action.run(
        async () => {
          const result = await consoleNewSetupLink(row.id);
          return result.ok ? { ok: true, data: result.data.url } : result;
        },
        { success: `New password link made for ${row.name}.`, onDone: setUrl },
      );
    } else {
      action.run(
        async () => {
          const result = await consoleReactivateStaff(row.id);
          return result.ok ? { ok: true, data: result.data.setupUrl } : result;
        },
        { success: `${row.name} is switched back on.`, onDone: setUrl },
      );
    }
  }

  return (
    <Dialog open onClose={close} title={mode === "link" ? "New password link" : "Switch back on"}>
      {url ? (
        <div className="space-y-4 p-0.5">
          <p className="text-sm text-text">
            {mode === "link" ? (
              <>Pass this link on to {name}. It works once; choosing a password with it signs them out everywhere.</>
            ) : (
              <>{name} is back on the staff as {ROLE_LABEL[row.role].label}. They choose a new password with this link, then set up two-factor again if it is required.</>
            )}
          </p>
          <OnceSecret
            label={`Password link for ${row.name}`}
            value={url}
            copyLabel="Copy password link"
            onDone={onClose}
            extra={
              <p className="text-xs text-muted">
                {mode === "link" ? `It is not emailed — send it to ${row.email} yourself. The link lasts 3 days.` : `Also emailed to ${row.email}. The link lasts 3 days.`}
              </p>
            }
          />
        </div>
      ) : (
        <ConfirmBody confirmLabel={mode === "link" ? "Make link" : "Switch back on"} pending={action.pending} error={action.error} onConfirm={confirm} onCancel={close}>
          {mode === "link" ? (
            <p>
              A one-time link for {name} to choose a new password. It lasts 3 days and replaces any earlier link; their current password keeps working until the
              link is used.
            </p>
          ) : (
            <p>
              {name} can sign in again as {ROLE_LABEL[row.role].label} — with a new password, since their old one no longer works, and a new authenticator. The
              link to choose it is emailed to {row.email} and shown here once.
            </p>
          )}
        </ConfirmBody>
      )}
    </Dialog>
  );
}
