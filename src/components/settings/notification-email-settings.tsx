"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Clock, Info, Monitor, RotateCcw, Send } from "lucide-react";
import type { NotificationType } from "@prisma/client";
import { resetNotificationEmails, setNotificationEmail } from "@/actions/notification";
import type { EmailChoice } from "@/lib/notifications/email-settings";
import { EMAILED_BY_DEFAULT } from "@/lib/notifications/email-defaults";
import { NOTIFICATION_CATALOGUE, NOTIFICATION_GROUPS } from "@/lib/notifications/catalogue";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/** Where they go out from: the company's mail server, or Deskzo's. */
export type NotificationSender = { via: "COMPANY"; from: string } | { via: "DESKZO" };

/**
 * Settings › Email notifications (owner, 18 Oct 2026): which kinds go by email as well as to the bell,
 * one switch per kind, the same for everyone it's raised for — src/lib/notifications/email-settings.ts.
 * Saved on the switch, as a person's own preferences are.
 */
export function NotificationEmailSettings({ choices, sender }: { choices: EmailChoice[]; sender: NotificationSender }) {
  const [, startTransition] = useTransition();
  const [rows, setRows] = useState(choices);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byType = new Map(rows.map((r) => [r.type, r]));
  const emailed = rows.filter((r) => r.email).length;
  const switchable = rows.filter((r) => r.switchable).length;
  const changed = rows.some((r) => !r.isDefault);

  const set = (type: NotificationType, email: boolean) => {
    const current = byType.get(type);
    if (!current?.switchable) return;
    // Moved at once so the switch responds, and put back if the server disagrees.
    setRows((prev) => prev.map((r) => (r.type === type ? { ...r, email, isDefault: false } : r)));
    setBusy(type);
    setError(null);
    startTransition(async () => {
      const result = await setNotificationEmail({ type, email });
      setBusy(null);
      if (!result.ok) {
        setRows((prev) => prev.map((r) => (r.type === type ? current : r)));
        setError(result.error);
      }
    });
  };

  const reset = () => {
    setBusy("__all__");
    setError(null);
    startTransition(async () => {
      const result = await resetNotificationEmails();
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRows((prev) => prev.map((r) => ({ ...r, email: r.switchable && EMAILED_BY_DEFAULT.has(r.type), isDefault: true })));
    });
  };

  return (
    <div className="space-y-4">
      {error && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

      <Card className="bg-surface-sunken">
        <CardContent className="space-y-2 py-3 text-sm">
          <div className="flex items-start gap-2 text-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <span className="font-medium text-text">
                {emailed} of {switchable}
              </span>{" "}
              kinds are emailed. Each goes as it happens, one email per notification, to the person it&apos;s for — whatever they&apos;ve
              switched off in their own bell, as this choice is the workspace&apos;s, not theirs.
            </span>
          </div>
          <div className="flex items-start gap-2 text-muted">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Reminders — a task due or overdue, a callback, a meeting about to start, a ticket past its SLA, a renewal coming up — are
              checked every five minutes and emailed as they fall due, even to people who haven&apos;t opened Deskzo. Switching one on
              doesn&apos;t email what&apos;s already pending.
            </span>
          </div>
          <div className="flex items-start gap-2 text-muted">
            <Send className="mt-0.5 h-4 w-4 shrink-0" />
            {sender.via === "COMPANY" ? (
              <span>
                Sent from <span className="font-medium text-text">{sender.from}</span>, your company&apos;s mail server (
                <Link href="/settings/messaging" className="text-brand hover:underline">
                  Mail &amp; messaging
                </Link>
                ). If it refuses one, Deskzo&apos;s mail service sends it instead.
              </span>
            ) : (
              <span>
                Sent by <span className="font-medium text-text">Deskzo&apos;s mail service</span>, in your company&apos;s name. To send them from your own
                address, set up your company&apos;s mail server under{" "}
                <Link href="/settings/messaging" className="text-brand hover:underline">
                  Mail &amp; messaging
                </Link>
                .
              </span>
            )}
          </div>
          {changed && (
            <div className="pt-1">
              <Button variant="secondary" size="sm" disabled={busy !== null} onClick={reset}>
                <RotateCcw className="h-3.5 w-3.5" />
                Back to the defaults
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {NOTIFICATION_GROUPS.map((group) => {
        const items = NOTIFICATION_CATALOGUE.filter((d) => d.group === group.key);
        if (items.length === 0) return null;
        return (
          <Card key={group.key}>
            <CardHeader>
              <div className="text-sm font-medium text-text">{group.label}</div>
              <div className="mt-0.5 text-xs text-muted">{group.blurb}</div>
            </CardHeader>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-5 py-2 font-medium">Notification</th>
                    <th className="w-28 px-3 py-2 text-center font-medium">Email it</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d) => {
                    const row = byType.get(d.type);
                    if (!row) return null;
                    return (
                      <tr key={d.type} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5">
                          <div className="text-text">{d.label}</div>
                          <div className="mt-0.5 text-xs text-muted">{d.when}</div>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          {row.switchable ? (
                            <input
                              type="checkbox"
                              className="h-4 w-4"
                              checked={row.email}
                              disabled={busy !== null}
                              aria-label={`Email "${d.label}"`}
                              onChange={(e) => set(d.type, e.target.checked)}
                            />
                          ) : (
                            <span
                              className="inline-flex items-center gap-1 text-xs text-muted"
                              title="It goes to everyone in the company, so one would email every employee. It stays in the bell."
                            >
                              <Monitor className="h-3 w-3" />
                              In the app only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
