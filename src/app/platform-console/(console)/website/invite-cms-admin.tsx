"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { LoaderCircle, UserPlus } from "lucide-react";
import { consoleInviteCmsAdmin } from "@/actions/platform/console-website";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";

/**
 * "Invite a CMS admin" (owners): a name and an email address make a CMS ADMIN account. The setup link
 * is emailed to them and shown here once, to pass on if the mail does not arrive — nothing keeps it
 * after the dialog closes. It opens only after hydration: a dialog is drawn into `<body>`.
 */

const noSubscribe = () => () => {};

export function InviteCmsAdminButton() {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ setupUrl: string; emailed: boolean }>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden="true" className="h-4 w-4" />
        Invite a CMS admin
      </Button>
      <Dialog open={open && isClient} onClose={close} title="Invite a CMS admin">
        <InviteForm action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function InviteForm({ action, onClose }: { action: ReturnType<typeof useConsoleAction<{ setupUrl: string; emailed: boolean }>>; onClose: () => void }) {
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [made, setMade] = useState<{ setupUrl: string; emailed: boolean; email: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The dialog focuses its close button in its own effect, after this one: wait a frame.
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const ready = name.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const sentTo = email.trim().toLowerCase();
    action.run(() => consoleInviteCmsAdmin({ name: name.trim(), email: sentTo }), {
      success: "CMS admin invited.",
      onDone: (data) => setMade({ ...data, email: sentTo }),
    });
  }

  if (made) {
    return (
      <div className="space-y-4 p-0.5">
        <p className="text-sm text-text">
          {made.emailed ? (
            <>
              An email with this link went to <strong className="font-medium">{made.email}</strong>. If it does not arrive, send them the link yourself.
            </>
          ) : (
            <>
              The email to <strong className="font-medium">{made.email}</strong> could not be sent. Send them this link yourself.
            </>
          )}{" "}
          It works once, for three days.
        </p>
        <OnceSecret label="Setup link" value={made.setupUrl} copyLabel="Copy setup link" onDone={onClose} />
      </div>
    );
  }

  const nameId = `${id}-name`;
  const emailId = `${id}-email`;
  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-muted">They choose their own password from an emailed link, and then manage the CMS&apos;s other accounts themselves.</p>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} ref={nameRef} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoComplete="off" readOnly={action.pending} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input id={emailId} type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} autoComplete="off" readOnly={action.pending} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Send invitation
        </Button>
      </div>
    </form>
  );
}
