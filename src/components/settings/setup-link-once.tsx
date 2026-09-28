"use client";

import { OnceSecret } from "@/components/console/kit/once-secret";

/**
 * The setup link, when its email couldn't be sent: for whoever added the person to pass on. Shown this once —
 * the server keeps only its hash — and gone when this goes. "Resend setup email" replaces it with a new one.
 */
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
