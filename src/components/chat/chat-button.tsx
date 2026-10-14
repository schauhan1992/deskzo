"use client";

import Link from "next/link";
import { MessageCircle } from "lucide-react";
import { useChatLive } from "@/components/chat/chat-live";

/**
 * The header's way into chat, with the number of unread messages — beside the bell, on every page.
 * Without the live connection (an admin viewing as somebody) it is the button alone, with no count: the
 * chat page then says chats are private.
 */
export function ChatButton() {
  const live = useChatLive();
  const unread = live?.unread ?? 0;
  const label = !live ? "Chat — private to each person, not shown while viewing as somebody" : unread > 0 ? `Chat — ${unread} unread` : "Chat";
  return (
    <Link
      href="/chat"
      title={label}
      aria-label={label}
      className="relative grid h-9 w-9 place-items-center rounded-base text-muted transition-colors hover:bg-surface-sunken hover:text-text"
    >
      <MessageCircle className="h-[18px] w-[18px]" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-medium text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </Link>
  );
}
