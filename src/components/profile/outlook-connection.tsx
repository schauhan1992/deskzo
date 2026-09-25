"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Plug, Unplug } from "lucide-react";
import { disconnectMailbox } from "@/actions/document-mail";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";
import { formatIstDateTime } from "@/lib/india-time";

/** What a round trip to Microsoft came back as — `?outlook=` on the way back here. */
const OUTCOMES: Record<string, { tone: "success" | "error" | "info"; text: string }> = {
  connected: { tone: "success", text: "Outlook connected. Documents you email from here now go out from your own mailbox." },
  declined: { tone: "info", text: "You didn't approve it at Microsoft, so nothing was connected." },
  expired: { tone: "error", text: "That took too long or was started in another window. Press Connect again." },
  mismatch: { tone: "error", text: "That Microsoft account isn't the one on your account here. Connect the mailbox for the email address on your profile." },
  "no-permission": { tone: "error", text: "Microsoft didn't grant permission to send mail. Ask IT to add Mail.Send (delegated) to the app, then connect again." },
  "not-configured": { tone: "error", text: "Microsoft 365 isn't set up for this company yet. An admin adds it under Settings → Security." },
  "viewing-as": { tone: "error", text: "You're viewing as somebody else — a mailbox can only be connected to your own account." },
  failed: { tone: "error", text: "Microsoft couldn't complete the connection. Try again in a minute." },
};

type Connection = {
  mailbox: string;
  displayName: string | null;
  connectedAt: string | Date;
  lastUsedAt: string | Date | null;
  brokenAt: string | Date | null;
  lastError: string | null;
};

/**
 * My profile → Outlook mailbox. Connecting lets the invoices, proposals and credit notes this person
 * emails go out from their own address — see src/lib/mail/microsoft.ts.
 */
export function OutlookConnection({
  appReady,
  connection,
  connectHref,
  outcome,
}: {
  appReady: boolean;
  connection: Connection | null;
  connectHref: string;
  outcome: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const said = outcome ? OUTCOMES[outcome] : null;

  function disconnect() {
    if (!window.confirm("Disconnect your Outlook? Documents can't be emailed from here until you connect it again.")) return;
    setError(null);
    startTransition(async () => {
      const r = await disconnectMailbox();
      if (!r.ok) setError(r.error);
      else router.replace("/profile");
    });
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        Connect your Microsoft 365 mailbox to email invoices, proposals and credit notes to customers from your own address. Each one lands in your Outlook
        Sent Items, and replies come back to you.
      </p>

      {said && <ActionNotice tone={said.tone}>{said.text}</ActionNotice>}
      {error && <ActionNotice tone="error">{error}</ActionNotice>}

      {!appReady ? (
        <p className="text-muted">Microsoft 365 isn&apos;t set up for this company yet — an admin adds it under Settings → Security.</p>
      ) : connection && !connection.brokenAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <div>
            <p className="flex items-center gap-1.5 font-medium text-text">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
              {connection.mailbox}
            </p>
            <p className="text-xs text-muted">
              Connected {formatIstDateTime(connection.connectedAt)}
              {connection.lastUsedAt ? ` · last used ${formatIstDateTime(connection.lastUsedAt)}` : ""}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={pending}>
            <Unplug className="mr-1 h-3.5 w-3.5" />
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {connection?.brokenAt && (
            <ActionNotice tone="error">
              Microsoft stopped accepting the connection for {connection.mailbox}
              {connection.lastError ? ` (${connection.lastError})` : ""}. Connect it again to keep sending.
            </ActionNotice>
          )}
          {/* A full navigation, not a fetch: the next page is Microsoft's own sign-in. */}
          <a
            href={connectHref}
            className="inline-flex items-center gap-1.5 rounded-base bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110"
          >
            <Plug className="h-3.5 w-3.5" />
            {connection?.brokenAt ? "Reconnect Outlook" : "Connect Outlook"}
          </a>
        </div>
      )}
    </div>
  );
}
