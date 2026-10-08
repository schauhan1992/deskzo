"use client";

import { useState, useTransition } from "react";
import { Info, Lock, RotateCcw } from "lucide-react";
import type { NotificationType } from "@prisma/client";
import {
  resetNotificationPreferences,
  setNotificationPreference,
  type PreferenceRow,
} from "@/actions/notification";
import { NOTIFICATION_CATALOGUE, NOTIFICATION_GROUPS } from "@/lib/notifications/catalogue";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * What each person wants to be told about.
 *
 * Grouped and written out in full, because the alternative — a list of thirty-nine enum names —
 * is a screen people close rather than use, and a notification system nobody tunes is one everybody
 * learns to ignore.
 *
 * Saved on the switch rather than behind a Save button. There is no coherent half-state to protect
 * against, and a page of forty toggles with one Save at the bottom is a page people leave without
 * pressing it.
 */

export function NotificationPreferences({ preferences }: { preferences: PreferenceRow[] }) {
  const [, startTransition] = useTransition();
  const [rows, setRows] = useState(preferences);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const byType = new Map(rows.map((r) => [r.type, r]));

  const set = (type: NotificationType, channel: "inApp" | "email", value: boolean) => {
    const current = byType.get(type);
    if (!current || current.alwaysOn) return;

    const next = { ...current, [channel]: value };
    // Moved at once so the switch responds, and put back if the server disagrees.
    setRows((prev) => prev.map((r) => (r.type === type ? next : r)));
    setBusy(type);
    setError(null);

    startTransition(async () => {
      const result = await setNotificationPreference({ type, inApp: next.inApp, email: next.email });
      setBusy(null);
      if (!result.ok) {
        setRows((prev) => prev.map((r) => (r.type === type ? current : r)));
        setError(result.error);
      }
    });
  };

  const resetAll = () => {
    setBusy("__all__");
    startTransition(async () => {
      await resetNotificationPreferences();
      setRows((prev) => prev.map((r) => ({ ...r, inApp: true, email: true })));
      setBusy(null);
    });
  };

  const muted = rows.filter((r) => !r.alwaysOn && (!r.inApp || !r.email)).length;

  return (
    <div className="space-y-4">
      {error && (
        <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      )}

      <Card className="bg-surface-sunken">
        <CardContent className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
          <div className="flex items-start gap-2 text-muted">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Everything is on until you say otherwise, so a new kind of notification reaches you without your
              having to find it here.{" "}
              <span className="font-medium text-text">Email goes out for a proforma issued on your deal</span>; for
              the rest, the email column is kept for when they&apos;re sent too.
            </span>
          </div>
          {muted > 0 && (
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={resetAll}>
              <RotateCcw className="h-3.5 w-3.5" />
              Turn all {muted} back on
            </Button>
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
                    <th className="px-5 py-2 font-medium">Tell me when…</th>
                    <th className="w-20 px-3 py-2 text-center font-medium">In app</th>
                    <th className="w-20 px-3 py-2 text-center font-medium">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d) => {
                    const row = byType.get(d.type);
                    if (!row) return null;
                    return (
                      <tr key={d.type} className="border-b border-line last:border-0">
                        <td className="px-5 py-2.5">
                          <div className="flex items-center gap-2 text-text">
                            {d.label}
                            {row.alwaysOn && (
                              <span
                                className="inline-flex items-center gap-1 text-xs text-muted"
                                title="Always on — it exists so somebody is told whether or not they want to be."
                              >
                                <Lock className="h-3 w-3" />
                                always on
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-muted">{d.when}</div>
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={row.inApp}
                            disabled={row.alwaysOn || busy !== null}
                            aria-label={`${d.label} — in app`}
                            onChange={(e) => set(d.type, "inApp", e.target.checked)}
                          />
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={row.email}
                            disabled={row.alwaysOn || busy !== null}
                            aria-label={`${d.label} — email`}
                            onChange={(e) => set(d.type, "email", e.target.checked)}
                          />
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
