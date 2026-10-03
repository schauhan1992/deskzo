"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarCheck2, CheckCircle2, Plug, Unplug } from "lucide-react";
import { disconnectMyConnection } from "@/actions/workplace-connection";
import type { CalendarSummary } from "@/actions/calendar";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";
import { useClock } from "@/components/time/clock-provider";
import { MAIL_NAMES, PROVIDER_NAMES, SIGN_IN_NAMES, mailConnectPath, providerOfMailSlug, sayEither, type WorkplaceProvider } from "@/lib/workplace/providers";

/** What a round trip to the provider came back as — `?mailbox=…&via=…` on the way back here. */
function outcomeNotice(outcome: string, provider: WorkplaceProvider, withCalendar: boolean): { tone: "success" | "error" | "info"; text: string } | null {
  const mail = MAIL_NAMES[provider];
  const who = SIGN_IN_NAMES[provider];
  switch (outcome) {
    case "connected":
      return withCalendar
        ? { tone: "success", text: `${mail} and your calendar connected. Meetings you schedule here go into your own calendar, and documents you email go out from your own mailbox.` }
        : { tone: "success", text: `${mail} connected. Documents you email from here now go out from your own mailbox.` };
    case "no-calendar":
      return {
        tone: "info",
        text:
          provider === "GOOGLE"
            ? `${mail} connected, but not your calendar — Google wasn't allowed it. Connect again and leave “View and edit events on all your calendars” ticked.`
            : provider === "ZOHO"
              ? `${mail} connected, but your Zoho Calendar couldn't be reached. Connect again and allow the calendar, or ask IT to add the ZohoCalendar scopes to your company's Zoho app.`
              : `${mail} connected, but not your calendar — ${who} didn't allow it. Ask IT to add Calendars.ReadWrite (delegated) to the app, then connect again.`,
      };
    case "declined":
      return { tone: "info", text: `You didn't approve it at ${who}, so nothing was connected.` };
    case "expired":
      return { tone: "error", text: "That took too long or was started in another window. Press Connect again." };
    case "mismatch":
      return { tone: "error", text: `That ${who} account isn't the one on your account here. Connect the mailbox for the email address on your profile.` };
    case "no-permission":
      return provider === "GOOGLE"
        ? { tone: "error", text: "Google wasn't given permission to send mail. Connect again and allow “Send email on your behalf”, or ask IT to add the gmail.send scope to your company's Google app." }
        : { tone: "error", text: `${who} didn't grant permission to send mail. Ask IT to add Mail.Send (delegated) to the app, then connect again.` };
    case "no-mailbox":
      return { tone: "error", text: `${who} didn't show a ${mail} account for the address on your profile. Check you have a mailbox at that address, and that your company's Zoho app asks for Zoho Mail.` };
    case "not-configured":
      return { tone: "error", text: `${PROVIDER_NAMES[provider]} isn't set up for mail in this company. An admin sets it up under Settings → Security.` };
    case "viewing-as":
      return { tone: "error", text: "You're viewing as somebody else — a mailbox can only be connected to your own account." };
    case "failed":
      return { tone: "error", text: `${who} couldn't complete the connection. Try again in a minute.` };
    default:
      return null;
  }
}

type Connection = {
  provider: WorkplaceProvider;
  mailbox: string;
  displayName: string | null;
  connectedAt: string | Date;
  lastUsedAt: string | Date | null;
  brokenAt: string | Date | null;
  lastError: string | null;
};

const linkClass = "inline-flex items-center gap-1.5 rounded-base bg-brand px-3 py-1.5 text-sm font-medium text-brand-contrast shadow-sm hover:brightness-110";

/**
 * My profile → Your mailbox (and calendar). Connecting lets the invoices, proposals and credit notes this
 * person emails go out from their own address — Outlook, Gmail or Zoho Mail, whichever the company offers
 * (src/lib/mail/mailbox.ts) — and, with Calendar on, keeps their own calendar in step (src/lib/calendar).
 */
export function MailboxConnection({
  providers,
  connection,
  outcome,
  via,
  mailUse = true,
  calendar = null,
}: {
  /** What the company offers for mail, in order. */
  providers: WorkplaceProvider[];
  connection: Connection | null;
  outcome: string | null;
  via: string | null;
  /** The workspace emails documents. */
  mailUse?: boolean;
  /** The person's calendar, with Calendar on; null without. */
  calendar?: CalendarSummary | null;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const said = outcome ? outcomeNotice(outcome, providerOfMailSlug(via) ?? "MICROSOFT", !!calendar) : null;
  // A mailbox with a provider the company no longer offers can't be sent from: connect one it does.
  const live = connection && providers.includes(connection.provider) ? connection : null;

  function disconnect() {
    if (!connection) return;
    const losing = [mailUse ? "documents can't be emailed from here" : null, calendar ? "your calendar stops syncing" : null].filter(Boolean).join(", and ");
    if (!window.confirm(`Disconnect your ${MAIL_NAMES[connection.provider]}?${losing ? ` Until you connect again, ${losing}.` : ""}`)) return;
    setError(null);
    startTransition(async () => {
      const r = await disconnectMyConnection();
      if (!r.ok) setError(r.error);
      else router.replace("/profile");
    });
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted">
        {mailUse
          ? "Connect your mailbox to email invoices, proposals and credit notes to customers from your own address. Each one lands in your Sent folder, and replies come back to you."
          : "Connect your account to keep your calendar in step here."}
        {calendar && mailUse && " The same connection keeps your calendar in step: meetings you schedule go into it, with the invitations sent from it."}
      </p>

      {said && <ActionNotice tone={said.tone}>{said.text}</ActionNotice>}
      {error && <ActionNotice tone="error">{error}</ActionNotice>}

      {live && !live.brokenAt ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
          <div>
            <p className="flex items-center gap-1.5 font-medium text-text">
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
              {live.mailbox}
            </p>
            <p className="text-xs text-muted">
              {MAIL_NAMES[live.provider]} · connected {clock.dateTime(live.connectedAt)}
              {live.lastUsedAt ? ` · last used ${clock.dateTime(live.lastUsedAt)}` : ""}
            </p>
          </div>
          <Button size="sm" variant="ghost" onClick={disconnect} disabled={pending}>
            <Unplug className="mr-1 h-3.5 w-3.5" />
            Disconnect
          </Button>
          {calendar && <CalendarLine calendar={calendar} provider={live.provider} />}
        </div>
      ) : providers.length === 0 ? (
        <p className="text-muted">Your company hasn&apos;t set up Microsoft 365, Google Workspace or Zoho for mail yet — an admin does it under Settings → Security.</p>
      ) : (
        <div className="space-y-2">
          {live?.brokenAt && (
            <ActionNotice tone="error">
              {SIGN_IN_NAMES[live.provider]} stopped accepting the connection for {live.mailbox}
              {live.lastError ? ` (${live.lastError})` : ""}. Connect it again to keep sending.
            </ActionNotice>
          )}
          {connection && !live && (
            <ActionNotice tone="info">
              Your {MAIL_NAMES[connection.provider]} ({connection.mailbox}) isn&apos;t used any more — your company sends through{" "}
              {sayEither(providers.map((p) => MAIL_NAMES[p]))} now.
            </ActionNotice>
          )}
          {/* Full navigations, not fetches: the next page is the provider's own sign-in. */}
          <div className="flex flex-wrap gap-2">
            {(live?.brokenAt ? [live.provider] : providers).map((provider) => (
              <a key={provider} href={mailConnectPath(provider, "/profile")} className={linkClass}>
                <Plug className="h-3.5 w-3.5" />
                {live?.brokenAt ? "Reconnect" : "Connect"} {MAIL_NAMES[provider]}
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const CALENDAR_OF: Record<WorkplaceProvider, string> = { MICROSOFT: "Outlook calendar", GOOGLE: "Google Calendar", ZOHO: "Zoho Calendar" };

/** Under a connected mailbox: whether the calendar came with it, and what to do when it didn't. */
function CalendarLine({ calendar, provider }: { calendar: CalendarSummary; provider: WorkplaceProvider }) {
  const clock = useClock();
  if (calendar.state === "ready") {
    return (
      <p className="flex w-full flex-wrap items-center gap-1.5 border-t border-line pt-2 text-xs text-muted">
        <CalendarCheck2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
        {CALENDAR_OF[provider]} {calendar.lastSyncedAt ? `synced ${clock.dateTime(calendar.lastSyncedAt)}` : "connected — the first sync is on its way"}
        {" · "}
        <Link href="/calendar" className="text-brand hover:underline">
          Open Calendar
        </Link>
      </p>
    );
  }
  if (calendar.state !== "no-calendar" && calendar.state !== "broken") return null;
  return (
    <div className="w-full border-t border-line pt-2 text-xs">
      <p className="text-warning">
        {calendar.state === "broken" ? `Your ${CALENDAR_OF[provider]} stopped letting Deskzo in${calendar.error ? ` (${calendar.error})` : ""}.` : `Your ${CALENDAR_OF[provider]} isn't connected — it wasn't allowed when you connected.`}
      </p>
      <a href={mailConnectPath(provider, "/profile")} className="mt-1 inline-block font-medium text-brand hover:underline">
        Connect again and allow the calendar
      </a>
    </div>
  );
}
