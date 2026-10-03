"use client";

import { usePathname } from "next/navigation";
import { CalendarX2 } from "lucide-react";
import type { CalendarSummary } from "@/actions/calendar";
import { MAIL_NAMES, PROVIDER_NAMES, mailConnectPath } from "@/lib/workplace/providers";

const CALENDAR_OF = { MICROSOFT: "Outlook calendar", GOOGLE: "Google Calendar", ZOHO: "Zoho Calendar" } as const;

/**
 * What stands between the person and their calendar, and the one thing to do about it — connect,
 * reconnect allowing the calendar, or ask an admin. Null when the calendar is ready.
 */
export function CalendarNotice({ summary, compact = false }: { summary: CalendarSummary; compact?: boolean }) {
  const pathname = usePathname() || "/calendar";
  if (summary.state === "ready") return null;

  let title: string;
  let body: string;
  let links: { href: string; label: string }[] = [];
  switch (summary.state) {
    case "off":
      title = "Calendar is switched off";
      body = "An admin can switch it on under Settings → Modules.";
      break;
    case "viewing-as":
      title = "Not while viewing as somebody else";
      body = "Their calendar is theirs to see. Stop viewing as them to use your own.";
      break;
    case "app-missing":
      title = "No calendar to connect yet";
      body = "An admin sets up Microsoft 365, Google Workspace or Zoho under Settings → Security; then each person connects their own.";
      break;
    case "not-connected":
      title = "Connect your calendar";
      body = "Your mailbox and calendar connect together, once — meetings you schedule here go into your own calendar, with the invitations sent from it.";
      links = summary.providers.map((p) => ({ href: mailConnectPath(p, pathname), label: `Connect ${PROVIDER_NAMES[p]}` }));
      break;
    case "no-calendar":
      title = `Allow your ${CALENDAR_OF[summary.provider]}`;
      body = `${MAIL_NAMES[summary.provider]} (${summary.mailbox}) is connected for mail, but not your calendar. Connect again and allow the calendar when ${PROVIDER_NAMES[summary.provider]} asks.`;
      links = [{ href: mailConnectPath(summary.provider, pathname), label: `Reconnect ${PROVIDER_NAMES[summary.provider]}` }];
      break;
    case "broken":
      title = `Your ${CALENDAR_OF[summary.provider]} needs connecting again`;
      body = summary.error ? `${PROVIDER_NAMES[summary.provider]} said: ${summary.error}` : `${PROVIDER_NAMES[summary.provider]} stopped letting Deskzo in — a changed password, or the permission withdrawn.`;
      links = [{ href: mailConnectPath(summary.provider, pathname), label: `Reconnect ${PROVIDER_NAMES[summary.provider]}` }];
      break;
  }

  return (
    <div className={compact ? "rounded-lg border border-line bg-surface-sunken p-3" : "rounded-xl border border-line bg-surface p-6 text-center"}>
      {!compact && <CalendarX2 className="mx-auto h-7 w-7 text-subtle" aria-hidden />}
      <p className={compact ? "text-sm font-medium text-text" : "mt-2 text-sm font-medium text-text"}>{title}</p>
      <p className="mt-1 text-sm text-muted">{body}</p>
      {links.length > 0 && (
        <div className={compact ? "mt-2 flex flex-wrap gap-2" : "mt-4 flex flex-wrap justify-center gap-2"}>
          {links.map((l) => (
            // A full navigation: the provider's consent screen, then back here.
            <a key={l.href} href={l.href} className="inline-flex h-8 items-center rounded-lg bg-brand px-3 text-[13px] font-medium text-brand-contrast shadow-sm hover:brightness-110">
              {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
