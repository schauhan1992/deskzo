"use client";

import { useEffect, useState } from "react";
import { inboxUnread } from "@/actions/inbox";
import { useChatLive } from "@/components/chat/chat-live";

/**
 * How many Customer inbox conversations are waiting on this person (src/lib/inbox/server.ts
 * `unreadCount`) — for the menu's count beside Customer inbox. Asked for once, again whenever team chat's
 * live connection says a conversation changed (no more than once every few seconds), and every couple of
 * minutes besides — every half minute without that connection. `on`: the inbox is in this person's menu,
 * which the server decided; nothing is asked for otherwise.
 */
export function useInboxUnread(on: boolean): number {
  const live = useChatLive();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      pending = null;
      inboxUnread()
        .then((n) => !stopped && setCount(n))
        .catch(() => {});
    };
    const soon = () => {
      if (!pending) pending = setTimeout(load, 3_000);
    };
    load();
    const every = setInterval(() => document.visibilityState === "visible" && load(), live?.connected ? 120_000 : 30_000);
    const unsubscribe = live?.subscribe((event) => event.type === "inbox" && soon());
    return () => {
      stopped = true;
      clearInterval(every);
      if (pending) clearTimeout(pending);
      unsubscribe?.();
    };
  }, [on, live]);

  return on ? count : 0;
}
