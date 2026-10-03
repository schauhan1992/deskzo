"use client";

import { OnceSecret } from "@/components/console/kit/once-secret";

/**
 * The setup link, when its email couldn't be sent: for whoever added the person to pass on. Shown this once —
 * the server keeps only its hash — and gone when this goes. "Resend setup email" replaces it with a new one.
 */
/**
 * The password reset link, when its email couldn't be sent: to pass on, the same way. Their current password
 * still works until they use it.
 */
export function ResetLinkOnce({ email, resetUrl, onDone }: { email: string; resetUrl: string; onDone?: () => void }) {
  return (
    <div className="space-y-3">
      <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
        The password email to {email} couldn&apos;t be sent. Copy this link and pass it on to them yourself — they open
        it to choose a new password. It works once, for 24 hours.
      </p>
      <OnceSecret
        label="Password reset link"
        value={resetUrl}
        copyLabel="Copy reset link"
        note="Shown once — it can't be retrieved later. Anybody with it can set this account's password, so send it only to them."
        onDone={onDone}
      />
    </div>
  );
}

/**
 * The temporary password an admin reset somebody's to (src/actions/user.ts `resetPasswordToTemporary`):
 * shown this once — only its hash is kept — for the admin to pass on.
 */
export function TemporaryPasswordOnce({ name, password, onDone }: { name: string; password: string; onDone?: () => void }) {
  return (
    <div className="space-y-3">
      <p role="status" className="rounded-md bg-success-bg px-3 py-2 text-sm text-success">
        {name}&apos;s password is reset, and they&apos;re signed out everywhere. Give them this temporary password; they&apos;ll
        choose their own when they next sign in.
      </p>
      <OnceSecret
        label="Temporary password"
        value={password}
        copyLabel="Copy password"
        note="Shown once — it can't be retrieved later. Pass it on privately, never in a group chat."
        onDone={onDone}
      />
    </div>
  );
}

export function SetupLinkOnce({ email, setupUrl, onDone }: { email: string; setupUrl: string; onDone?: () => void }) {
  return (
    <div className="space-y-3">
      <p role="alert" className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">
        The setup email to {email} couldn&apos;t be sent. Copy this link and pass it on to them yourself — they open
        it to choose their own password. It works once, for three days.
      </p>
      <OnceSecret
        label="Setup link"
        value={setupUrl}
        copyLabel="Copy setup link"
        note="Shown once — it can't be retrieved later. Anybody with it can set up this account, so send it only to them."
        onDone={onDone}
      />
    </div>
  );
}
