"use client";

import { useEffect, useState } from "react";
import { AtSign, Bell, BellOff, BellRing, MessageCirclePlus, Search, Users, UsersRound } from "lucide-react";
import { searchChatMessages, type ChatBootstrap, type ChatSearchHit } from "@/actions/chat";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { useClock } from "@/components/time/clock-provider";
import { useChatLive, useDesktopAlerts, type DesktopAlerts } from "@/components/chat/chat-live";
import { NewChatDialog, NewGroupDialog } from "@/components/chat/chat-dialogs";
import { isMuted } from "@/lib/chat/rules";
import type { ChatSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

const ALERT_LABELS: Record<Exclude<DesktopAlerts, "unsupported">, string> = {
  ask: "Turn on desktop alerts — see new messages while Deskzo is in the background",
  on: "Desktop alerts are on in this browser — click to turn them off here",
  off: "Desktop alerts are off in this browser — click to turn them on",
  blocked: "Desktop alerts are blocked for this site — allow notifications in your browser's site settings",
};

/**
 * Desktop alerts for this browser: asks the browser the first time, then switches them on and off here.
 * They say who and where, never what (src/components/chat/chat-live.tsx).
 */
function AlertsSwitch() {
  const { state, toggle } = useDesktopAlerts();
  if (state === "unsupported") return null;
  const icon = state === "on" ? BellRing : state === "ask" ? Bell : BellOff;
  return <IconButton icon={icon} label={ALERT_LABELS[state]} onClick={toggle} disabled={state === "blocked"} className={state === "ask" ? "text-brand" : undefined} />;
}

/** Keeps an empty preview line its height. */
const NBSP = String.fromCharCode(160);

/** A person's chats, newest first, with the search over their names and over what was said. */
export function ChatList({
  boot,
  chats,
  activeId,
  typing,
  onOpen,
  onStarted,
}: {
  boot: ChatBootstrap;
  chats: ChatSummary[];
  activeId: string | null;
  typing: Record<string, { userId: string; name: string; until: number }[]>;
  onOpen: (chatId: string | null, messageId?: string) => void;
  onStarted: (chatId: string) => void;
}) {
  const clock = useClock();
  const live = useChatLive();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; hits: ChatSearchHit[] } | null>(null);
  const [dialog, setDialog] = useState<"chat" | "group" | null>(null);

  // What was said, as well as who: searched once typing pauses.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => {
      void searchChatMessages(q)
        .then((hits) => setFound({ query: q, hits }))
        .catch(() => setFound({ query: q, hits: [] }));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const q = query.trim().toLowerCase();
  // Only the answer to what is in the box now: a slower, older search never shows under a newer query.
  const hits = found && found.query === query.trim() && q.length >= 2 ? found.hits : null;
  const shown = q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
  const today = clock.today();
  const when = (iso: string | null) => (!iso ? "" : clock.dateKey(new Date(iso)) === today ? clock.time(iso) : clock.dayMonth(iso));

  return (
    <>
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="text-sm font-semibold text-text">Chats</h2>
        <div className="flex items-center gap-0.5">
          <AlertsSwitch />
          <IconButton icon={MessageCirclePlus} label="New chat" onClick={() => setDialog("chat")} />
          <IconButton icon={UsersRound} label="New group" onClick={() => setDialog("group")} />
        </div>
      </div>
      <div className="shrink-0 border-b border-line p-2">
        <label className="relative block">
          <span className="sr-only">Search chats and messages</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats and messages"
            className="h-8 w-full rounded-base border border-line bg-surface-sunken pl-8 pr-2 text-[13px] text-text placeholder:text-subtle focus:border-brand focus:outline-none"
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && !hits?.length && (
          <div className="px-4 py-10 text-center text-sm text-muted">
            {q ? "No chats by that name." : "No chats yet."}
            {!q && (
              <div className="mt-3 flex justify-center gap-2">
                <button type="button" className="text-brand underline-offset-2 hover:underline" onClick={() => setDialog("chat")}>
                  Message a colleague
                </button>
                <span aria-hidden="true">·</span>
                <button type="button" className="text-brand underline-offset-2 hover:underline" onClick={() => setDialog("group")}>
                  Make a group
                </button>
              </div>
            )}
          </div>
        )}
        <ul role="list">
          {shown.map((c) => {
            const typers = typing[c.id] ?? [];
            const muted = isMuted(c.mutedUntil);
            const online = c.otherUserId ? live?.online.has(c.otherUserId) : false;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onOpen(c.id)}
                  aria-current={c.id === activeId ? "true" : undefined}
                  className={cn(
                    "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-sunken",
                    c.id === activeId && "bg-brand-subtle/60 hover:bg-brand-subtle/60",
                  )}
                >
                  <span className="relative shrink-0">
                    {c.kind === "GROUP" ? (
                      <span className="grid h-9 w-9 place-items-center rounded-full bg-surface-sunken text-muted">
                        <Users className="h-4 w-4" />
                      </span>
                    ) : (
                      <Avatar user={{ id: c.otherUserId ?? c.id, name: c.title, photoUpdatedAt: c.otherPhotoUpdatedAt }} size="md" />
                    )}
                    {online && <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-surface" aria-label="Online" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={cn("truncate text-[13px] text-text", c.unread > 0 ? "font-semibold" : "font-medium")}>{c.title}</span>
                      <span className={cn("shrink-0 text-[11px]", c.unread > 0 && !muted ? "font-medium text-brand" : "text-subtle")}>{when(c.lastMessageAt)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className={cn("truncate text-xs", typers.length ? "italic text-brand" : "text-muted")}>
                        {typers.length ? (c.kind === "GROUP" ? `${typers[0]!.name.split(/\s+/)[0]} is typing…` : "typing…") : c.left ? "You're no longer in this group" : c.preview || NBSP}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {muted && <BellOff className="h-3 w-3 text-subtle" aria-label="Muted" />}
                        {c.mentioned && c.unread > 0 && (
                          <span className="grid h-4 w-4 place-items-center rounded-full bg-brand text-brand-contrast" aria-label="You were mentioned">
                            <AtSign className="h-2.5 w-2.5" />
                          </span>
                        )}
                        {c.unread > 0 && (
                          <span className={cn("flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-medium", muted ? "bg-surface-sunken text-muted" : "bg-brand text-brand-contrast")}>
                            {c.unread > 99 ? "99+" : c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {hits && hits.length > 0 && (
          <div className="border-t border-line">
            <p className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide text-subtle">Messages</p>
            <ul role="list">
              {hits.map((h) => (
                <li key={h.messageId}>
                  <button type="button" onClick={() => onOpen(h.chatId, h.messageId)} className="block w-full px-3 py-2 text-left hover:bg-surface-sunken">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-xs font-medium text-text">{h.chatTitle}</span>
                      <span className="shrink-0 text-[11px] text-subtle">{when(h.createdAt)}</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {h.senderName ? `${h.senderName.split(/\s+/)[0]}: ` : ""}
                      {h.snippet}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {hits && hits.length === 0 && q.length >= 2 && shown.length > 0 && <p className="px-3 py-3 text-xs text-subtle">No messages contain that.</p>}
      </div>

      <NewChatDialog open={dialog === "chat"} onClose={() => setDialog(null)} people={boot.people} onStarted={onStarted} />
      <NewGroupDialog open={dialog === "group"} onClose={() => setDialog(null)} boot={boot} onStarted={onStarted} />
    </>
  );
}
