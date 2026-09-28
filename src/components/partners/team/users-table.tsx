"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, LogOut, MonitorSmartphone, TriangleAlert } from "lucide-react";
import {
  partnerDeactivateUser,
  partnerEndUserSessions,
  partnerNewSetupLink,
  partnerReactivateUser,
  partnerResetUserTwoFactor,
  partnerSetUserRole,
  partnerUserSessions,
} from "@/actions/partners/team";
import { ConfirmBody, ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { RowMenu, type RowMenuItem } from "@/components/console/kit/row-menu";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { DeviceIcon } from "@/components/partners/common/device-icon";
import { PartnerRolePill } from "@/components/partners/common/pills";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { SidePane } from "@/components/ui/side-pane";
import { plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import { PARTNER_ROLE_DESCRIPTIONS, PARTNER_ROLE_LABELS, type PartnerRole, type PartnerSessionRow, type PartnerTwoFactorMode, type PartnerUserRow } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { PartnerRoleCards } from "./invite-dialog";

/**
 * The partner's people (admins only): role, two-factor, last sign-in, how many sessions they have
 * open right now — a count that opens those sessions in a side pane — and where their account stands
 * (invited, active, link expired, switched off). Everything goes through src/actions/partners/team.ts,
 * which acts only on this partner's own users.
 *
 * Every row but the admin's own has a menu: change the role, sign out everywhere, reset two-factor, a
 * new password link (shown once in its dialog, never in the table), switch off — and switch back on,
 * which starts them over with a new link. Switching off and on show what changes before they run.
 * The server checks every one again, and its refusal (the last active admin, the fifty-user limit) is
 * shown as it says it, in the dialog that asked. Your own account is managed in My account.
 */

type Pending =
  | { kind: "role"; row: PartnerUserRow }
  | { kind: "sign-out"; row: PartnerUserRow }
  | { kind: "two-factor"; row: PartnerUserRow }
  | { kind: "link"; row: PartnerUserRow }
  | { kind: "switch-off"; row: PartnerUserRow }
  | { kind: "switch-on"; row: PartnerUserRow };

/** Where an account stands, in words. */
export function partnerAccountState(row: PartnerUserRow): { label: string; tone: Tone; title: string } {
  if (!row.active) return { label: "Switched off", tone: "neutral", title: "Can't sign in. Switch them back on to send a new link." };
  if (!row.hasPassword && row.setupPending) return { label: "Invited", tone: "info", title: "Their link to choose a password hasn't been used yet." };
  if (!row.hasPassword) return { label: "Link expired", tone: "warning", title: "Their link expired before they chose a password. Send a new one." };
  return { label: "Active", tone: "success", title: "Can sign in." };
}

export function PartnerUsersTable({ rows, me, policy }: { rows: PartnerUserRow[]; me: string; policy: PartnerTwoFactorMode }) {
  const [paneFor, setPaneFor] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const paneRow = paneFor ? (rows.find((r) => r.id === paneFor) ?? null) : null;

  function ask(next: Pending) {
    // One modal at a time: an action started from the sessions pane replaces it.
    setPaneFor(null);
    setPending(next);
  }

  function menuFor(row: PartnerUserRow): RowMenuItem[] {
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
      <DataTable caption="Partner portal users" minWidth={900}>
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
            const state = partnerAccountState(row);
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
                      <p translate="no" className="max-w-[18rem] truncate text-xs text-muted" title={row.email}>
                        {row.email}
                      </p>
                    </div>
                  </div>
                </Td>
                <Td nowrap>
                  <PartnerRolePill role={row.role} />
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
                    <Link href={PARTNER_ROUTES.account} className="rounded-base px-2 py-1 text-xs font-medium text-brand hover:underline">
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
        {paneRow && <SessionsList key={paneRow.id} row={paneRow} self={paneRow.id === me} policy={policy} onSignOut={() => ask({ kind: "sign-out", row: paneRow })} />}
      </SidePane>

      {pending && <PendingDialog key={`${pending.kind}-${pending.row.id}`} pending={pending} onClose={() => setPending(null)} />}
    </>
  );
}

type SessionsState = { sessions: PartnerSessionRow[]; loading: boolean; error: string | null };

/** One person's live sessions, asked for when the pane opens (the list never carries them). */
function SessionsList({ row, self, policy, onSignOut }: { row: PartnerUserRow; self: boolean; policy: PartnerTwoFactorMode; onSignOut: () => void }) {
  const [state, setState] = useState<SessionsState>({ sessions: [], loading: true, error: null });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    partnerUserSessions(row.id).then(
      (r) => setState(r.ok ? { sessions: r.data, loading: false, error: null } : { sessions: [], loading: false, error: r.error }),
      () => setState({ sessions: [], loading: false, error: "The sessions could not be loaded. Close this and try again." }),
    );
  }, [row.id]);

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">A session ends after 60 minutes without use, or 12 hours after signing in.</p>
      {self ? (
        <Link href={PARTNER_ROUTES.account} className="inline-flex items-center gap-1 text-[13px] font-medium text-brand hover:underline">
          Manage your own sessions in My account
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      ) : (
        row.active && (
          <Button type="button" variant="secondary" size="sm" onClick={onSignOut}>
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Sign {row.name} out everywhere
          </Button>
        )
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
function PendingDialog({ pending, onClose }: { pending: Pending; onClose: () => void }) {
  switch (pending.kind) {
    case "role":
      return <RoleDialog row={pending.row} onClose={onClose} />;
    case "link":
      return <LinkDialog row={pending.row} mode="link" onClose={onClose} />;
    case "switch-on":
      return <LinkDialog row={pending.row} mode="reactivate" onClose={onClose} />;
    case "switch-off":
      return <SwitchOffDialog row={pending.row} onClose={onClose} />;
    case "sign-out":
    case "two-factor":
      return <SimpleDialog kind={pending.kind} row={pending.row} onClose={onClose} />;
  }
}

/** "becomes Finance — commissions, statements …" — the role's own line, mid-sentence. */
function consequence(name: string, role: PartnerRole): string {
  const line = PARTNER_ROLE_DESCRIPTIONS[role];
  return `${name} becomes ${PARTNER_ROLE_LABELS[role]} — ${line.charAt(0).toLowerCase()}${line.slice(1)} It applies from their next click.`;
}

function RoleDialog({ row, onClose }: { row: PartnerUserRow; onClose: () => void }) {
  const action = useConsoleAction<null>();
  const [role, setRole] = useState<PartnerRole>(row.role);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Change ${row.name}'s role`}
      confirmLabel={role === row.role ? "Change role" : `Make ${PARTNER_ROLE_LABELS[role]}`}
      confirmDisabled={role === row.role}
      tone={row.role === "ADMIN" && role !== "ADMIN" ? "danger" : "primary"}
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => partnerSetUserRole(row.id, role), { success: `${row.name} is now ${PARTNER_ROLE_LABELS[role]}.`, onDone: onClose })}
    >
      <PartnerRoleCards legend="New role" value={role} onChange={setRole} current={row.role} disabled={action.pending} />
      {role !== row.role && <p className="text-sm text-muted">{consequence(row.name, role)}</p>}
    </ConfirmDialog>
  );
}

const SIMPLE = {
  "sign-out": {
    title: (n: string) => `Sign ${n} out everywhere`,
    confirm: "Sign out everywhere",
    tone: "primary" as const,
    body: (r: PartnerUserRow) => `Every session ${r.name} has open ends now — ${plural(r.liveSessions, "session")}. They can sign straight back in with their password.`,
  },
  "two-factor": {
    title: (n: string) => `Reset ${n}'s two-factor`,
    confirm: "Reset two-factor",
    tone: "danger" as const,
    body: (r: PartnerUserRow) =>
      `For a lost or replaced phone: ${r.name}'s authenticator is forgotten and they're signed out everywhere. They set up a new one at their next sign-in (or sign in with a password alone while two-factor is optional).`,
  },
};

function SimpleDialog({ kind, row, onClose }: { kind: keyof typeof SIMPLE; row: PartnerUserRow; onClose: () => void }) {
  const action = useConsoleAction<{ ended: number } | null>();
  const spec = SIMPLE[kind];
  function confirm() {
    if (kind === "sign-out") {
      action.run(() => partnerEndUserSessions(row.id), {
        success: (d) => (!d || d.ended === 0 ? `${row.name} had no session left to end.` : `Signed ${row.name} out of ${plural(d.ended, "session")}.`),
        onDone: onClose,
      });
    } else {
      action.run(() => partnerResetUserTwoFactor(row.id), { success: `${row.name}'s two-factor is reset.`, onDone: onClose });
    }
  }
  return (
    <ConfirmDialog open onClose={onClose} title={spec.title(row.name)} confirmLabel={spec.confirm} tone={spec.tone} pending={action.pending} error={action.error} onConfirm={confirm}>
      <p>{spec.body(row)}</p>
    </ConfirmDialog>
  );
}

/** Switching somebody off, with what it changes set out first (a tier-2 confirmation). */
function SwitchOffDialog({ row, onClose }: { row: PartnerUserRow; onClose: () => void }) {
  const action = useConsoleAction<null>();
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={`Switch ${row.name} off`}
      confirmLabel="Switch off"
      tone="danger"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => partnerDeactivateUser(row.id), { success: `${row.name} is switched off.`, onDone: onClose })}
    >
      <p>{`${row.name} can't sign in to the partner portal again until an admin switches them back on — they'd start over with a new link.`}</p>
      <ImpactList
        items={[
          { label: "Sessions", value: row.liveSessions > 0 ? `${plural(row.liveSessions, "session")} ended now` : "None open", tone: row.liveSessions > 0 ? "warning" : undefined },
          { label: "Password link", value: row.setupPending ? "The one out now stops working" : "None out" },
          { label: "Role while off", value: PARTNER_ROLE_LABELS[row.role] },
          { label: "What they did", value: "Stays in the activity log" },
        ]}
      />
    </ConfirmDialog>
  );
}

/**
 * A new password link (the old one stops working), or switching somebody back on (which starts them
 * over: no password, no authenticator, a new link — and takes one of the partner's places again).
 * Asked first; then the link is shown once, in this dialog, with whether the email went out.
 */
function LinkDialog({ row, mode, onClose }: { row: PartnerUserRow; mode: "link" | "reactivate"; onClose: () => void }) {
  const action = useConsoleAction<{ setupUrl: string; emailed: boolean }>();
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
            action.run(() => (reactivate ? partnerReactivateUser(row.id) : partnerNewSetupLink(row.id)), {
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
                  { label: "Role", value: PARTNER_ROLE_LABELS[row.role] },
                  { label: "Password", value: "Chosen again with the link" },
                  { label: "Two-factor", value: "Set up again" },
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
