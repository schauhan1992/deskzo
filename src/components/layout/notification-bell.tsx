"use client";

import Link from "next/link";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell } from "lucide-react";
import { getNotifications, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead } from "@/actions/notification";
import { cn } from "@/lib/utils";

type NotificationRow = {
  id: string;
  title: string;
  message: string | null;
  link: string | null;
  read: boolean;
  createdAt: Date | string;
};

const POLL_MS = 45000;

function timeAgo(date: Date | string) {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    async function refreshCount() {
      setCount(await getUnreadNotificationCount());
    }
    refreshCount();
    const interval = setInterval(refreshCount, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && !loaded) {
      getNotifications({ limit: 20 }).then((list) => {
        setNotifications(list);
        setLoaded(true);
      });
    }
  }

  function handleItemClick(notification: NotificationRow) {
    setOpen(false);
    if (!notification.read) {
      startTransition(async () => {
        await markNotificationRead(notification.id);
      });
      setNotifications((prev) => prev.map((n) => (n.id === notification.id ? { ...n, read: true } : n)));
      setCount((c) => Math.max(0, c - 1));
    }
    if (notification.link) router.push(notification.link);
  }

  function handleMarkAllRead() {
    startTransition(async () => {
      await markAllNotificationsRead();
    });
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setCount(0);
  }

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={toggleOpen}
        aria-label="Notifications"
        className="relative rounded-md p-2 text-muted hover:bg-surface-sunken hover:text-text"
      >
        <Bell className="h-4 w-4" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-medium text-white">
            {count > 9 ? "9+" : count}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 rounded-md border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-medium text-text">Notifications</span>
            {count > 0 && (
              <button type="button" onClick={handleMarkAllRead} className="text-xs text-muted hover:text-text hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {!loaded && <div className="px-3 py-6 text-center text-sm text-subtle">Loading…</div>}
            {loaded && notifications.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-subtle">You&apos;re all caught up.</div>
            )}
            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleItemClick(n)}
                className={cn(
                  "block w-full border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-surface-sunken",
                  !n.read && "bg-surface-sunken/80",
                )}
              >
                <div className="flex items-start gap-2">
                  {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-600" />}
                  <div className="min-w-0">
                    <div className={cn("text-sm", n.read ? "text-muted" : "font-medium text-text")}>{n.title}</div>
                    {n.message && <div className="truncate text-xs text-muted">{n.message}</div>}
                    <div className="mt-0.5 text-xs text-subtle">{timeAgo(n.createdAt)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {/*
            The way out of the dropdown.

            Without it the bell is a dead end: it shows the most recent twenty and there is no
            gesture that reaches the twenty-first. Shown even when the list is empty, because
            "nothing new" is exactly when somebody goes looking for what they already dismissed.
          */}
          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block border-t border-line px-3 py-2 text-center text-sm font-medium text-brand hover:bg-surface-sunken"
          >
            See all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
