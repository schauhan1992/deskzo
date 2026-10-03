"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Archive, ArchiveRestore, Check, Trash2 } from "lucide-react";
import type { NotificationType } from "@prisma/client";
import {
  archiveNotification,
  deleteNotifications,
  markNotificationRead,
  unarchiveNotification,
  type NotificationRow,
} from "@/actions/notification";
import { notificationLabel } from "@/lib/notifications/catalogue";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";

/**
 * The history, with the actions the bell never had.
 *
 * Reading and archiving are deliberately separate: somebody scanning a backlog marks things read as
 * they go and archives what they have actually dealt with. One flag doing both jobs would lose that
 * the first time anybody used it in anger.
 */

export function NotificationList({
  rows,
  view,
}: {
  rows: NotificationRow[];
  view: "inbox" | "archived";
}) {
  const router = useRouter();
  const clock = useClock();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    startTransition(async () => {
      await fn();
      setBusy(false);
      setPicked(new Set());
      router.refresh();
    });
  };

  const ids = [...picked];
  const allPicked = rows.length > 0 && picked.size === rows.length;

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-base border border-line bg-surface px-3 py-2">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={(e) => setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())}
              className="h-4 w-4"
            />
            {picked.size > 0 ? `${picked.size} selected` : "Select all on this page"}
          </label>

          {picked.size > 0 && (
            <div className="ml-auto flex flex-wrap gap-2">
              {view === "inbox" ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => archiveNotification({ ids }))}>
                  <Archive className="h-3.5 w-3.5" />
                  Archive
                </Button>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(() => unarchiveNotification({ ids }))}>
                  <ArchiveRestore className="h-3.5 w-3.5" />
                  Put back
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => deleteNotifications({ ids }))}>
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            </div>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted">
            {view === "archived" ? "Nothing archived." : "Nothing here."}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-line">
              {rows.map((n) => (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 px-4 py-3 ${n.read ? "" : "bg-brand-subtle/30"}`}
                >
                  <input
                    type="checkbox"
                    checked={picked.has(n.id)}
                    onChange={() => toggle(n.id)}
                    className="mt-1 h-4 w-4 shrink-0"
                    aria-label={`Select ${n.title}`}
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {/* The catalogue label, never the raw enum — nobody reads REGULARISATION_DECIDED. */}
                      <Badge tone="default">{notificationLabel(n.type as NotificationType)}</Badge>
                      {!n.read && <span className="text-xs font-medium text-brand">Unread</span>}
                      <span className="text-xs text-subtle">{clock.dateTimeShort(n.createdAt)}</span>
                    </div>

                    <p className="mt-1 text-sm font-medium text-text">
                      {n.link ? (
                        <Link
                          href={n.link}
                          onClick={() => {
                            // Read on the way out, so following a link is not also a second click.
                            if (!n.read) void markNotificationRead(n.id);
                          }}
                          className="text-brand hover:underline"
                        >
                          {n.title}
                        </Link>
                      ) : (
                        n.title
                      )}
                    </p>
                    {n.message && <p className="mt-0.5 text-sm text-muted">{n.message}</p>}
                  </div>

                  <div className="flex shrink-0 gap-1">
                    {!n.read && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Mark read"
                        onClick={() => run(() => markNotificationRead(n.id))}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    {view === "inbox" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Archive"
                        onClick={() => run(() => archiveNotification({ ids: [n.id] }))}
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="Put back"
                        onClick={() => run(() => unarchiveNotification({ ids: [n.id] }))}
                      >
                        <ArchiveRestore className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
