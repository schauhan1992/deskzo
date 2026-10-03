"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, MonitorSmartphone, TriangleAlert } from "lucide-react";
import {
  cmsDeactivateUser,
  cmsEndUserSession,
  cmsEndUserSessions,
  cmsNewSetupLink,
  cmsReactivateUser,
  cmsResetUserTwoFactor,
  cmsSetUserRole,
  cmsUserSessions,
} from "@/actions/cms/users";
import { DeviceIcon } from "@/components/console/account/sessions-table";
import { ConfirmBody, ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { CmsRolePill } from "@/components/cms/common/status";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { useClock } from "@/components/time/clock-provider";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SidePane } from "@/components/ui/side-pane";
import { plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { CMS_ROLE_DESCRIPTIONS, CMS_ROLE_LABELS, type CmsRole, type CmsSessionRow, type CmsTwoFactorMode, type CmsUserRow } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { CmsRoleCards } from "./invite-dialog";

/**
 * The CMS's people (admins only): role, two-factor, last sign-in, how many sessions they have open
 * right now — a count that opens those sessions in a side pane — and where their account stands
 * (invited, active, link expired, switched off).
 *
 * Every row but the admin's own has a menu: change the role (the cards say what each may do; the last
 * active admin stays an admin), sign out everywhere, reset two-factor, a new password link (shown once
 * in its dialog, never in the table), switch off (typed confirmation) — and switch back on, which
 * starts them over with a new link. The server checks every one again, and its refusal is shown in
 * the dialog that asked. Your own account is managed in My account.
 */

type Pending =
  | { kind: "role"; row: CmsUserRow }
  | { kind: "sign-out"; row: CmsUserRow }
  | { kind: "two-factor"; row: CmsUserRow }
  | { kind: "link"; row: CmsUserRow }
  | { kind: "switch-off"; row: CmsUserRow }
  | { kind: "switch-on"; row: CmsUserRow }
  | { kind: "session"; row: CmsUserRow; session: CmsSessionRow };

/** Where an account stands, in words. */
export function accountState(row: CmsUserRow): { label: string; tone: Tone; title: string } {
  if (!row.active) return { label: "Switched off", tone: "neutral", title: "Can't sign in. Switch them back on to send a new link." };
  if (!row.hasPassword && row.setupPending) return { label: "Invited", tone: "info", title: "Their link to choose a password hasn't been used yet." };
  if (!row.hasPassword) return { label: "Link expired", tone: "warning", title: "Their link expired before they chose a password. Send a new one." };
  return { label: "Active", tone: "success", title: "Can sign in." };
}

export function UsersTable({ rows, me, policy, activeAdmins }: { rows: CmsUserRow[]; me: string; policy: CmsTwoFactorMode; activeAdmins: number }) {
  const [paneFor, setPaneFor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const paneRow = paneFor ? (rows.find((r) => r.id === paneFor) ?? null) : null;

  function ask(next: Pending) {
    // One modal at a time: a confirmation opened from the sessions pane replaces it, and the pane
    // comes back (fresh) when the confirmation closes.
    setPaneFor(null);
    setPending(next);
  }

  function closeDialog() {
    if (pending?.kind === "session") setPaneFor(pending.row.id);
    setPending(null);
  }

  function menuFor(row: CmsUserRow): RowMenuItem[] {
    if (!row.active) return [{ key: "switch-on", label: "Switch back on…", onSelect: () => ask({ kind: "switch-on", row }) }];
    return [
      { key: "role", label: "Change role…", onSelect: () => ask({ kind: "role", row }) },
      { key: "access", separator: true },
      ...(row.liveSessions > 0 ? [{ key: "sign-out", label: "Sign out everywhere…", onSelect: () => ask({ kind: "sign-out", row }) }] : []),
      ...(row.twoFactor ? [{ key: "two-factor", label: "Reset two-factor…", onSelect: () => ask({ kind: "two-factor", row }) }] : []),
      { key: "link", label: row.hasPassword ? "New password link…" : "New setup link…", onSelect: () => ask({ kind: "link", row }) },
      { key: "end", separator: true },
      { key: "switch-off", label: "Switch off…", danger: true, onSelect: () => ask({ kind: "switch-off", row }) },
    ];
  }

  return (
    <>
      <DataTable caption="CMS users" minWidth={900}>
        <THead>
          <Th>Person</Th>
          <Th>Role</Th>
          <Th>Two-factor</Th>
          <Th>Last sign-in</Th>
          <Th>Signed in now</Th>
          <Th>Account</Th>
          <Th srOnly>Actions</Th>
        </THead>
        <TBody>
          {rows.map((row) => {
            const self = row.id === me;
            const state = accountState(row);
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
                  <CmsRolePill role={row.role} />
                </Td>
                <Td nowrap>
                  {row.twoFactor ? (
                    <StatusPill tone="success">Set up</StatusPill>
                  ) : (
                    <StatusPill tone={policy === "required" && row.active ? "warning" : "neutral"} title={policy === "required" ? "Asked to set one up at their next sign-in" : undefined}>
                      Not set up
                    </StatusPill>
                  )}
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
                  <StatusPill tone={state.tone} title={state.title}>
                    {state.label}
                  </StatusPill>
                </Td>
                <RowActionsCell>
                  {self ? (
                    <Link href={CMS_ROUTES.account} className="rounded-base px-2 py-1 text-xs font-medium text-brand hover:underline">
                      My account
                    </Link>
                  ) : (
                    <RowMenu label={`Actions for ${row.name}`} items={menuFor(row)} />
                  )}
                </RowActionsCell>
              </Tr>
            );
          })}
        </TBody>
      </DataTable>

      <SidePane open={paneRow !== null} onClose={() => setPaneFor(null)} title={paneRow ? `Sessions · ${paneRow.name}` : "Sessions"}>
        {paneRow && <SessionsList key={paneRow.id} row={paneRow} self={paneRow.id === me} policy={policy} onEnd={(session) => ask({ kind: "session", row: paneRow, session })} />}
      </SidePane>

      {pending && <PendingDialog key={`${pending.kind}-${pending.row.id}`} pending={pending} activeAdmins={activeAdmins} onClose={closeDialog} />}
    </>
  );
}

type SessionsState = { sessions: CmsSessionRow[]; loading: boolean; error: string | null };

/** One person's live sessions, asked for when the pane opens (the list never carries them). */
function SessionsList({ row, self, policy, onEnd }: { row: CmsUserRow; self: boolean; policy: CmsTwoFactorMode; onEnd: (session: CmsSessionRow) => void }) {
  const [state, setState] = useState<SessionsState>({ sessions: [], loading: true, error: null });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    cmsUserSessions(row.id).then(
      (r) => setState(r.ok ? { sessions: r.data, loading: false, error: null } : { sessions: [], loading: false, error: r.error }),
      () => setState({ sessions: [], loading: false, error: "The sessions could not be loaded. Close this and try again." }),
    );
  }, [row.id]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">A session ends after 60 minutes without use, or 12 hours after signing in.</p>
      {self && (
        <Link href={CMS_ROUTES.account} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
          Manage your own sessions in My account
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      )}
      <div aria-live="polite" aria-busy={state.loading || undefined}>
        {state.loading ? (
          <p className="text-sm text-muted">Loading sessions…</p>
        ) : state.error ? (
          <p className="text-sm text-danger">{state.error}</p>
        ) : state.sessions.length === 0 ? (
          <div className="grid place-items-center rounded-lg border border-dashed border-line px-4 py-8 text-center">
            <MonitorSmartphone aria-hidden="true" className="h-5 w-5 text-subtle" />
            <p className="mt-2 text-sm text-muted">Not signed in anywhere now.</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {state.sessions.map((s) => (
              <li key={s.handle} className="rounded-lg border border-line bg-surface px-4 py-3">
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
                  {!self && (
                    <Button type="button" variant="secondary" size="sm" onClick={() => onEnd(s)} aria-label={`Sign ${row.name} out on ${s.device}`}>
                      Sign out
                    </Button>
                  )}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-xs">
                  <div>
                    <dt className="text-muted">Signed in</dt>
                    <dd className="text-text">
                      <RelativeTime at={s.createdAt} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Expires</dt>
                    <dd className="text-text">
                      <RelativeTime at={s.expiresAt} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Two-factor</dt>
                    <dd>{s.mfa ? <span className="text-success">Passed</span> : <span className={policy === "required" ? "text-warning" : "text-muted"}>Not asked</span>}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">IP address</dt>
                    <dd className="font-mono text-text">{s.ip ?? "—"}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The dialog for whichever row action was chosen. Mounted while open, so each starts clean. */
function PendingDialog({ pending, activeAdmins, onClose }: { pending: Pending; activeAdmins: number; onClose: () => void }) {
  switch (pending.kind) {
    case "role":
      return <RoleDialog row={pending.row} lastAdmin={pending.row.role === "ADMIN" && activeAdmins <= 1} onClose={onClose} />;
    case "link":
      return <LinkDialog row={pending.row} mode="link" onClose={onClose} />;
    case "switch-on":
      return <LinkDialog row={pending.row} mode="reactivate" onClose={onClose} />;
    case "sign-out":
      return <SimpleDialog kind="sign-out" row={pending.row} onClose={onClose} />;
    case "two-factor":
      return <SimpleDialog kind="two-factor" row={pending.row} onClose={onClose} />;
    case "switch-off":
      return <SimpleDialog kind="switch-off" row={pending.row} lastAdmin={pending.row.role === "ADMIN" && activeAdmins <= 1} onClose={onClose} />;
    case "session":
      return <EndSessionDialog row={pending.row} session={pending.session} onClose={onClose} />;
  }
}

/** "becomes Editor — edits and publishes …" — the role's own line, mid-sentence. */
function consequence(name: string, role: CmsRole): string {
  const line = CMS_ROLE_DESCRIPTIONS[role];
  return `${name} becomes ${CMS_ROLE_LABELS[role]} — ${line.charAt(0).toLowerCase()}${line.slice(1)} It applies from their next click.`;
}

function RoleDialog({ row, lastAdmin, onClose }: { row: CmsUserRow; lastAdmin: boolean; onClose: () => void }) {
  const action = useCmsAction<null>();
  const [role, setRole] = useState<CmsRole>(row.role);
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title={`Change ${row.name}'s role`}
      confirmLabel={role === row.role ? "Change role" : `Make ${CMS_ROLE_LABELS[role]}`}
      confirmDisabled={role === row.role}
      tone={row.role === "ADMIN" && role !== "ADMIN" ? "danger" : "primary"}
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsSetUserRole(row.id, role), { success: `${row.name} is now ${CMS_ROLE_LABELS[role]}.`, onDone: onClose })}
    >
      {lastAdmin && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{row.name} is the only active admin, and the CMS always keeps one. Make somebody else an admin first.</span>
        </p>
      )}
      <CmsRoleCards legend="New role" value={role} onChange={setRole} current={row.role} disabled={action.pending} lockedTo={lastAdmin ? "ADMIN" : undefined} />
      {role !== row.role && <p className="text-sm text-muted">{consequence(row.name, role)}</p>}
    </ConfirmDialog>
  );
}

const SIMPLE = {
  "sign-out": {
    title: (n: string) => `Sign ${n} out everywhere`,
    confirm: "Sign out everywhere",
    tone: "primary" as const,
    body: (r: CmsUserRow) => `Every session ${r.name} has open ends now — ${plural(r.liveSessions, "session")}. They can sign straight back in with their password.`,
  },
  "two-factor": {
    title: (n: string) => `Reset ${n}'s two-factor`,
    confirm: "Reset two-factor",
    tone: "danger" as const,
    body: (r: CmsUserRow) =>
      `For a lost or replaced phone: ${r.name}'s authenticator is forgotten and they're signed out everywhere. They set up a new one at their next sign-in (or sign in with a password alone while two-factor is optional).`,
  },
  "switch-off": {
    title: (n: string) => `Switch ${n} off`,
    confirm: "Switch off",
    tone: "danger" as const,
    body: (r: CmsUserRow) =>
      `${r.name} is signed out everywhere and can't sign in again; any password link they have stops working. Their pages, posts and images stay, and so does the activity log. You can switch them back on later — they'd start over with a new link.`,
  },
};

function SimpleDialog({ kind, row, lastAdmin = false, onClose }: { kind: keyof typeof SIMPLE; row: CmsUserRow; lastAdmin?: boolean; onClose: () => void }) {
  const action = useCmsAction<unknown>();
  const spec = SIMPLE[kind];
  const close = () => {
    if (!action.pending) onClose();
  };
  function confirm() {
    if (kind === "sign-out") {
      action.run(() => cmsEndUserSessions(row.id), {
        success: (d) => {
          const ended = (d as { ended: number }).ended;
          return ended === 0 ? `${row.name} had no session left to end.` : `Signed ${row.name} out of ${plural(ended, "session")}.`;
        },
        onDone: onClose,
      });
    } else if (kind === "two-factor") {
      action.run(() => cmsResetUserTwoFactor(row.id), { success: `${row.name}'s two-factor is reset.`, onDone: onClose });
    } else {
      action.run(() => cmsDeactivateUser(row.id), { success: `${row.name} is switched off.`, onDone: onClose });
    }
  }
  return (
    <ConfirmDialog
      open
      onClose={close}
      title={spec.title(row.name)}
      confirmLabel={spec.confirm}
      tone={spec.tone}
      typed={kind === "switch-off" ? row.email : undefined}
      confirmDisabled={kind === "switch-off" && lastAdmin}
      pending={action.pending}
      error={action.error}
      onConfirm={confirm}
    >
      {kind === "switch-off" && lastAdmin && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{row.name} is the only active admin, and the CMS always keeps one. Make somebody else an admin first.</span>
        </p>
      )}
      <p>{spec.body(row)}</p>
    </ConfirmDialog>
  );
}

/**
 * A new password link (the old one stops working), or switching somebody back on (which starts them
 * over: no password, no authenticator, a new link). Asked first; then the link is shown once, in
 * this dialog, with whether the email went out.
 */
function LinkDialog({ row, mode, onClose }: { row: CmsUserRow; mode: "link" | "reactivate"; onClose: () => void }) {
  const action = useCmsAction<{ setupUrl: string; emailed: boolean }>();
  const [result, setResult] = useState<{ setupUrl: string; emailed: boolean } | null>(null);
  const close = () => {
    if (!action.pending) onClose();
  };
  const reactivate = mode === "reactivate";
  const title = result ? (reactivate ? `${row.name} is switched back on` : "New link ready") : reactivate ? `Switch ${row.name} back on` : row.hasPassword ? "Send a new password link" : "Send a new setup link";

  return (
    <Dialog open onClose={close} title={title}>
      {result ? (
        <div className="space-y-4 p-0.5">
          <OnceSecret
            label={`Password link for ${row.name}`}
            value={result.setupUrl}
            copyLabel="Copy link"
            onDone={onClose}
            extra={
              result.emailed ? (
                <p className="text-xs text-muted">{`Also emailed to ${row.email}. It works once, for 3 days.`}</p>
              ) : (
                <p className="flex items-start gap-1.5 text-xs text-warning">
                  <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
                  <span>{`The email to ${row.email} couldn't be sent — pass this link on yourself. It works once, for 3 days.`}</span>
                </p>
              )
            }
          />
        </div>
      ) : (
        <ConfirmBody
          confirmLabel={reactivate ? "Switch back on" : "Send link"}
          pending={action.pending}
          error={action.error}
          onCancel={close}
          onConfirm={() =>
            action.run(() => (reactivate ? cmsReactivateUser(row.id) : cmsNewSetupLink(row.id)), {
              success: reactivate ? `${row.name} is switched back on.` : `A new link is on its way to ${row.email}.`,
              onDone: setResult,
            })
          }
        >
          {reactivate ? (
            <>
              <p>{`${row.name} starts over: their old password never works again, any authenticator is forgotten, and a new link to choose a password goes to ${row.email}.`}</p>
              <ImpactList
                items={[
                  { label: "Role", value: CMS_ROLE_LABELS[row.role] },
                  { label: "Link lasts", value: "3 days, once" },
                ]}
              />
            </>
          ) : (
            <p>{`A new link to choose a password goes to ${row.email}, and you'll see it once here to pass on. Any link sent before stops working. ${row.hasPassword ? "Their current password keeps working until they use it." : ""}`}</p>
          )}
        </ConfirmBody>
      )}
    </Dialog>
  );
}

function EndSessionDialog({ row, session, onClose }: { row: CmsUserRow; session: CmsSessionRow; onClose: () => void }) {
  const clock = useClock();
  const action = useCmsAction<null>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Sign out this session"
      confirmLabel="Sign out"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsEndUserSession(row.id, session.handle), { success: `Signed ${row.name} out on ${session.device}.`, onDone: onClose })}
    >
      <p>
        {row.name}&apos;s session on <strong className="font-medium">{session.device}</strong>, last used {clock.dateTime(session.lastSeenAt)}, ends now. Whoever is using it is sent to the
        sign-in page at their next click.
      </p>
    </ConfirmDialog>
  );
}
