"use client";

import { useId, useState, type FormEvent } from "react";
import { LoaderCircle, LogOut, Monitor, ShieldCheck, ShieldOff, Smartphone } from "lucide-react";
import { cmsEndMyOtherSessions, cmsEndMySession, cmsRemoveMyTwoFactor, cmsRenameMe } from "@/actions/cms/auth";
import { DeviceIcon } from "@/components/console/account/sessions-table";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { TextField } from "@/components/cms/common/fields";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { CmsEnrolForm } from "@/components/cms/shell/auth-forms";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { plural, when } from "@/lib/console-shared/format";
import type { CmsSessionRow, CmsTwoFactorMode } from "@/lib/cms/types";

/**
 * My account's controls — every one about the signed-in person only: their name, their sessions,
 * their authenticator (src/actions/cms/auth.ts, which acts on the session's own user and nobody
 * else's). Changing the password is a one-time link to their own address, never a field here.
 */

/** Their name as the CMS shows it — in the activity log, on their drafts, in the user menu. */
export function RenameForm({ name }: { name: string }) {
  const action = useCmsAction<null>();
  const [value, setValue] = useState(name);
  const [seen, setSeen] = useState(name);
  // A rename saved (or made elsewhere) arrives as a new prop: the field follows it.
  if (seen !== name) {
    setSeen(name);
    setValue(name);
  }
  const clean = value.replace(/\s+/g, " ").trim();
  const changed = clean !== name;
  const valid = clean.length >= 2 && clean.length <= 120;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changed || !valid || action.pending) return;
    action.run(() => cmsRenameMe(clean), { success: "Your name is changed." });
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-busy={action.pending || undefined}>
      <TextField
        label="Name"
        value={value}
        onChange={setValue}
        max={120}
        required
        readOnly={action.pending}
        autoComplete="name"
        error={changed && !valid ? "Between 2 and 120 characters." : null}
        hint="Shown to the team on your drafts and in the activity log."
      />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      {changed && (
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={!valid} aria-disabled={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
            {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Save name
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setValue(name)} disabled={action.pending}>
            Cancel
          </Button>
        </div>
      )}
    </form>
  );
}

/**
 * Two-factor for the signed-in person. Set up: when, and removing it — proven with a current code, so
 * a borrowed session alone cannot. Not set up: the QR code the page made on the server and the same
 * two steps as the sign-in door, behind a disclosure.
 */
export function TwoFactorCard({ enrolled, policy, challenge }: { enrolled: boolean; policy: CmsTwoFactorMode; challenge: { qr: string; secret: string } | null }) {
  const [removing, setRemoving] = useState(false);
  const required = policy === "required";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-lg bg-surface-sunken text-muted">
            <Smartphone className="h-4 w-4" />
          </span>
          <span className="text-[13px] font-medium text-text">Authenticator app</span>
        </span>
        {enrolled ? (
          <StatusPill tone="success" icon={<ShieldCheck className="h-3 w-3" />}>
            On
          </StatusPill>
        ) : (
          <StatusPill tone={required ? "warning" : "neutral"} icon={<ShieldOff className="h-3 w-3" />}>
            Not set up
          </StatusPill>
        )}
      </div>

      {enrolled ? (
        <>
          <p className="text-xs text-muted">You&apos;re asked for a code from your phone at every sign-in. Changing phones? Remove it here and set up the new one.</p>
          <Button type="button" variant="secondary" size="sm" onClick={() => setRemoving(true)}>
            Remove authenticator…
          </Button>
          {removing && <RemoveTwoFactorDialog required={required} onClose={() => setRemoving(false)} />}
        </>
      ) : (
        <>
          <p className="text-xs text-muted">
            {required ? "Two-factor is required — you'll be asked to set it up at your next sign-in." : "Two-factor is optional here, but it's the best protection for an account that can publish to the public site."}
          </p>
          {challenge && (
            <details className="group rounded-lg border border-line">
              <summary className="cursor-pointer list-none px-3 py-2 text-[13px] font-medium text-brand hover:underline [&::-webkit-details-marker]:hidden">Set up an authenticator</summary>
              <div className="space-y-4 border-t border-line p-3">
                {/* A data: URL made on the server for this person only. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={challenge.qr} alt="QR code for your authenticator app" width={180} height={180} className="mx-auto rounded-lg border border-line" />
                <CmsEnrolForm secret={challenge.secret} mode="account" />
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function RemoveTwoFactorDialog({ required, onClose }: { required: boolean; onClose: () => void }) {
  const id = useId();
  const action = useCmsAction<null>();
  const [code, setCode] = useState("");
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Remove your authenticator"
      confirmLabel="Remove"
      tone="danger"
      confirmDisabled={code.length !== 6}
      pending={action.pending}
      error={action.error}
      onConfirm={() =>
        action.run(() => cmsRemoveMyTwoFactor(code), {
          success: required ? "Authenticator removed. Set up the new one now." : "Authenticator removed. You'll sign in with your password alone.",
          onDone: onClose,
        })
      }
    >
      <p>
        Enter a current code from the app to prove it&apos;s yours. Your other sessions are signed out.{" "}
        {required ? "Two-factor is required, so you'll set up an authenticator again straight away." : "While two-factor is optional, you'll sign in with your password alone."}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-code`}>The 6-digit code the app shows</Label>
        <Input
          id={`${id}-code`}
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          readOnly={action.pending}
          className="font-mono tracking-[0.3em] tabular-nums"
        />
      </div>
    </ConfirmDialog>
  );
}

/**
 * Where the signed-in person is signed in to the CMS now, this device first and marked. Any other
 * can be signed out on its own, or all of them at once; this one is the user menu's to end.
 */
export function CmsMySessions({ sessions }: { sessions: CmsSessionRow[] }) {
  const [ending, setEnding] = useState<CmsSessionRow | null>(null);
  const [endingOthers, setEndingOthers] = useState(false);
  const others = sessions.filter((s) => !s.current).length;

  return (
    <Panel
      title="Sessions"
      description="Where you're signed in to the CMS right now."
      padded={false}
      actions={
        others > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEndingOthers(true)}>
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Sign out everywhere else
          </Button>
        ) : undefined
      }
      footer={`${others === 0 ? "Only this device is signed in. " : ""}A session ends after 60 minutes without use, or 12 hours after signing in.`}
    >
      {sessions.length === 0 ? (
        <EmptyState icon={<Monitor className="h-5 w-5" />} title="No live sessions" body="Sessions appear here while you're signed in." />
      ) : (
        <DataTable caption="Your sessions" minWidth={720}>
          <THead>
            <Th>Device</Th>
            <Th>IP address</Th>
            <Th>Signed in</Th>
            <Th>Last seen</Th>
            <Th>Two-factor</Th>
            <Th srOnly>Actions</Th>
          </THead>
          <TBody>
            {sessions.map((s) => (
              <Tr key={s.handle} className={s.current ? "bg-surface-sunken/60" : undefined}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
                      <DeviceIcon device={s.device} className="h-3.5 w-3.5" />
                    </span>
                    <span className="font-medium whitespace-nowrap text-text">{s.device}</span>
                    {s.current && (
                      <StatusPill tone="brand" dot>
                        This device
                      </StatusPill>
                    )}
                  </div>
                </Td>
                <Td mono muted nowrap>
                  {s.ip ?? "—"}
                </Td>
                <Td muted nowrap>
                  <RelativeTime at={s.createdAt} />
                </Td>
                <Td muted nowrap>
                  <RelativeTime at={s.lastSeenAt} />
                </Td>
                <Td nowrap>{s.mfa ? <span className="text-success">Passed</span> : <span className="text-muted">Not asked</span>}</Td>
                <RowActionsCell>
                  {!s.current && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEnding(s)} aria-label={`Sign out ${s.device}, last seen ${when(s.lastSeenAt)}`}>
                      Sign out
                    </Button>
                  )}
                </RowActionsCell>
              </Tr>
            ))}
          </TBody>
        </DataTable>
      )}

      {ending && <EndMySessionDialog key={ending.handle} session={ending} onClose={() => setEnding(null)} />}
      {endingOthers && <EndOthersDialog others={others} onClose={() => setEndingOthers(false)} />}
    </Panel>
  );
}

function EndMySessionDialog({ session, onClose }: { session: CmsSessionRow; onClose: () => void }) {
  const action = useCmsAction<null>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Sign out session"
      confirmLabel="Sign out"
      pending={action.pending}
      error={action.error}
      onConfirm={() => action.run(() => cmsEndMySession(session.handle), { success: `Signed out of ${session.device}.`, onDone: onClose })}
    >
      <p>
        Your session on <strong className="font-medium">{session.device}</strong>, last used {when(session.lastSeenAt)}, ends now. Whoever is using it is sent to the sign-in
        page at their next click.
      </p>
    </ConfirmDialog>
  );
}

function EndOthersDialog({ others, onClose }: { others: number; onClose: () => void }) {
  const action = useCmsAction<{ ended: number }>();
  const close = () => {
    if (!action.pending) onClose();
  };
  return (
    <ConfirmDialog
      open
      onClose={close}
      title="Sign out everywhere else"
      confirmLabel="Sign out everywhere else"
      pending={action.pending}
      error={action.error}
      onConfirm={() =>
        action.run(() => cmsEndMyOtherSessions(), {
          success: (d) => (d.ended === 0 ? "No other session was still signed in." : `Signed out of ${plural(d.ended, "other session")}.`),
          onDone: onClose,
        })
      }
    >
      <p>
        {`You're signed out of the CMS on ${plural(others, "other device")}. This one stays signed in.`} If you think somebody else has your password, email yourself a new
        password link too.
      </p>
    </ConfirmDialog>
  );
}
