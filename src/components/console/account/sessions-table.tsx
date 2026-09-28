"use client";

import { useState } from "react";
import { LogOut, Monitor, Smartphone, Tablet } from "lucide-react";
import { consoleEndMyOtherSessions, consoleEndMySession } from "@/actions/platform/console-admin";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowActionsCell, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { plural, when } from "@/lib/console-shared/format";
import type { StaffSessionView } from "@/lib/platform/staff";

/**
 * My account › Sessions (spec §3.19): every device where the viewer is signed in to the console
 * right now, this one first and marked. Any other can be signed out on its own, or all of them at
 * once; this one is left alone — signing out here is the staff menu's job.
 *
 * Only the viewer's own sessions arrive here (the loader reads them by the signed-in id) and the
 * actions refuse anybody else's, so the address shown is always the viewer's own.
 */

type MySession = StaffSessionView & { current: boolean };

/** How a session is shown, from the device name the loader worked out (never the raw user agent). */
export function DeviceIcon({ device, className = "h-4 w-4" }: { device: string; className?: string }) {
  const Icon = /ipad|tablet/i.test(device) ? Tablet : /iphone|android|mobile|phone/i.test(device) ? Smartphone : Monitor;
  return <Icon aria-hidden="true" className={className} />;
}

export function MySessions({ sessions }: { sessions: MySession[] }) {
  const [ending, setEnding] = useState<MySession | null>(null);
  const [endingOthers, setEndingOthers] = useState(false);
  const others = sessions.filter((s) => !s.current).length;

  return (
    <Panel
      title="Sessions"
      description="Where you're signed in to the console right now."
      padded={false}
      actions={
        others > 0 ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => setEndingOthers(true)}>
            <LogOut aria-hidden="true" className="h-4 w-4" />
            Sign out everywhere else
          </Button>
        ) : undefined
      }
      footer={`${others === 0 ? "Only this device is signed in. " : ""}A session ends after 30 minutes without use, or 12 hours after signing in.`}
    >
      {sessions.length === 0 ? (
        <EmptyState icon={<Monitor className="h-5 w-5" />} title="No live sessions" body="Sessions appear here while you are signed in." />
      ) : (
        <DataTable caption="Your sessions" minWidth={760}>
          <THead>
            <Th>Device</Th>
            <Th>IP address</Th>
            <Th>Started</Th>
            <Th>Last seen</Th>
            <Th>Expires</Th>
            <Th srOnly>Actions</Th>
          </THead>
          <TBody>
            {sessions.map((s) => (
              <Tr key={s.id} className={s.current ? "bg-surface-sunken/60" : undefined}>
                <Td>
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface-sunken text-muted">
                      <DeviceIcon device={s.device} className="h-3.5 w-3.5" />
                    </span>
                    <span className="font-medium whitespace-nowrap text-text">{s.device}</span>
                    {s.current && (
                      <StatusPill tone="brand" dot>
                        This session
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
                <Td muted nowrap>
                  <RelativeTime at={s.expiresAt} />
                </Td>
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

      {/* Mounted while open, so each opening starts without the last one's refusal. */}
      {ending && <EndMySessionDialog key={ending.id} session={ending} onClose={() => setEnding(null)} />}
      {endingOthers && <EndOtherSessionsDialog others={others} onClose={() => setEndingOthers(false)} />}
    </Panel>
  );
}

/** One other device signed out (T1). */
function EndMySessionDialog({ session, onClose }: { session: MySession; onClose: () => void }) {
  const action = useConsoleAction<null>();
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
      onConfirm={() => action.run(() => consoleEndMySession(session.id), { success: `Signed out of ${session.device}.`, onDone: onClose })}
    >
      <p>
        Your session on <strong className="font-medium">{session.device}</strong>, last used {when(session.lastSeenAt)}, ends now. Whoever is using it is sent to the
        sign-in page at their next click.
      </p>
    </ConfirmDialog>
  );
}

/** Every device but this one signed out (T1). */
function EndOtherSessionsDialog({ others, onClose }: { others: number; onClose: () => void }) {
  const action = useConsoleAction<{ ended: number }>();
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
        action.run(() => consoleEndMyOtherSessions(), {
          success: (data) => (data.ended === 0 ? "No other session was still signed in." : `Signed out of ${plural(data.ended, "other session")}.`),
          onDone: onClose,
        })
      }
    >
      <p>
        {`You're signed out of the console on ${plural(others, "other device")}. This device stays signed in.`} If you think somebody else has your password, ask for
        a new password link too.
      </p>
    </ConfirmDialog>
  );
}
