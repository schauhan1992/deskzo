"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { chatBootstrap, listChatSummaries, markChatRead, openChat, type ChatBootstrap } from "@/actions/chat";
import { useChatEvents, useChatLive } from "@/components/chat/chat-live";
import { ChatList } from "@/components/chat/chat-list";
import { ChatThread, type ThreadState } from "@/components/chat/chat-thread";
import { TYPING_SHOWN_MS, previewOf } from "@/lib/chat/rules";
import type { ChatEvent, ChatMessageView, ChatSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/**
 * The chat screen: the list of a person's chats beside the one open — or, in the rail's narrow panel
 * (`compact`), one or the other with a way back.
 *
 * Everything on it is kept current by the live stream (src/components/chat/chat-live.tsx); when the
 * stream reconnects after a gap, the list and the open chat are read again, so nothing that happened
 * in between is missed.
 */
export function ChatApp({ initialChatId = null, initialMessageId = null, compact = false }: { initialChatId?: string | null; initialMessageId?: string | null; compact?: boolean }) {
  const live = useChatLive();
  const [boot, setBoot] = useState<ChatBootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialChatId);
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [typing, setTyping] = useState<Record<string, { userId: string; name: string; until: number }[]>>({});
  const activeRef = useRef(activeId);
  const threadsRef = useRef(threads);
  useEffect(() => {
    activeRef.current = activeId;
    threadsRef.current = threads;
  });

  // Without the live connection (viewing as somebody) there is nothing to ask the server for: it would refuse.
  const hasLive = !!live;
  useEffect(() => {
    if (!hasLive) return;
    chatBootstrap()
      .then((b) => {
        setBoot(b);
        setChats(b.chats);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Chat couldn't be opened."));
  }, [hasLive]);

  const loadThread = useCallback(async (chatId: string, around?: string | null) => {
    const opened = await openChat(chatId, around ?? undefined);
    if (!opened) {
      setActiveId((id) => (id === chatId ? null : id));
      return;
    }
    setThreads((t) => ({ ...t, [chatId]: { members: opened.members, messages: opened.messages, hasMore: opened.hasMore, highlight: around ?? null } }));
    setChats((list) => mergeRows(list, [opened.summary]));
  }, []);

  // The chat on screen: loaded once, then kept current by events.
  useEffect(() => {
    if (!activeId || threadsRef.current[activeId]) return;
    void loadThread(activeId, activeId === initialChatId ? initialMessageId : null);
  }, [activeId, loadThread, initialChatId, initialMessageId]);

  // Read, once it's in front of the person: their ticks go blue on the other side, and the count drops.
  const markRead = useCallback(
    (chatId: string) => {
      if (document.visibilityState !== "visible") return;
      void markChatRead(chatId)
        .then(({ total }) => {
          live?.setUnread(total);
          setChats((list) => list.map((c) => (c.id === chatId ? { ...c, unread: 0, mentioned: false } : c)));
        })
        .catch(() => {});
    },
    [live],
  );
  const lastCount = activeId ? threads[activeId]?.messages.length ?? 0 : 0;
  useEffect(() => {
    if (activeId && lastCount > 0) markRead(activeId);
  }, [activeId, lastCount, markRead]);

  // The chat being looked at, for the sound and the count (chat-live.tsx); and read again on return.
  useEffect(() => {
    if (!live) return;
    live.setViewing(activeId);
    const onVisible = () => {
      if (document.visibilityState === "visible" && activeRef.current) markRead(activeRef.current);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      live.setViewing(null, activeId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [activeId, live, markRead]);

  const refreshRows = useCallback(async (chatIds?: string[]) => {
    const rows = await listChatSummaries(chatIds);
    setChats((list) => (chatIds ? mergeRows(list, rows) : rows));
  }, []);

  function clearTyping(chatId: string, userId: string) {
    setTyping((t) => ({ ...t, [chatId]: (t[chatId] ?? []).filter((x) => x.userId !== userId) }));
  }

  useChatEvents((event: ChatEvent) => {
    switch (event.type) {
      case "ready": {
        // Back after a gap: read everything again.
        void refreshRows();
        if (activeRef.current) void loadThread(activeRef.current);
        return;
      }
      case "message": {
        const m = event.message;
        const known = chats.some((c) => c.id === m.chatId);
        if (threadsRef.current[m.chatId]) {
          setThreads((t) => {
            const thread = t[m.chatId];
            if (!thread || thread.messages.some((x) => x.id === m.id)) return t;
            return { ...t, [m.chatId]: { ...thread, messages: [...thread.messages, m] } };
          });
        }
        if (!known) {
          void refreshRows([m.chatId]);
          return;
        }
        const mine = m.senderId === boot?.me.id;
        const looking = activeRef.current === m.chatId && document.visibilityState === "visible";
        setChats((list) =>
          sortRows(
            list.map((c) =>
              c.id === m.chatId
                ? {
                    ...c,
                    preview: previewLine(m, c.kind === "GROUP", mine),
                    lastMessageAt: m.createdAt,
                    unread: mine || looking || m.kind !== "TEXT" ? c.unread : c.unread + 1,
                    mentioned: c.mentioned || (!looking && event.mentioned),
                  }
                : c,
            ),
          ),
        );
        if (m.senderId) clearTyping(m.chatId, m.senderId);
        return;
      }
      case "message-updated": {
        const m = event.message;
        setThreads((t) => {
          const thread = t[m.chatId];
          if (!thread) return t;
          return { ...t, [m.chatId]: { ...thread, messages: thread.messages.map((x) => (x.id === m.id ? m : x)) } };
        });
        void refreshRows([m.chatId]);
        return;
      }
      case "receipt": {
        setThreads((t) => {
          const thread = t[event.chatId];
          if (!thread) return t;
          return {
            ...t,
            [event.chatId]: {
              ...thread,
              members: thread.members.map((m) => (m.userId === event.userId ? { ...m, lastDeliveredAt: event.lastDeliveredAt, lastReadAt: event.lastReadAt } : m)),
            },
          };
        });
        return;
      }
      case "typing": {
        setTyping((t) => {
          const now = Date.now();
          const others = (t[event.chatId] ?? []).filter((x) => x.userId !== event.userId && x.until > now);
          return { ...t, [event.chatId]: [...others, { userId: event.userId, name: event.name, until: now + TYPING_SHOWN_MS }] };
        });
        setTimeout(() => setTyping((t) => ({ ...t, [event.chatId]: (t[event.chatId] ?? []).filter((x) => x.until > Date.now()) })), TYPING_SHOWN_MS + 100);
        return;
      }
      case "chat-changed": {
        void refreshRows([event.chatId]);
        if (threadsRef.current[event.chatId]) void loadThread(event.chatId);
        return;
      }
      default:
        return;
    }
  });

  const open = useCallback(
    (chatId: string | null, messageId?: string) => {
      setActiveId(chatId);
      if (chatId && messageId) void loadThread(chatId, messageId);
      // The address follows the open chat, so a reload or a copied link opens it — without asking the
      // server for the page again on every click.
      if (!compact) window.history.replaceState(null, "", chatId ? `/chat?c=${encodeURIComponent(chatId)}` : "/chat");
    },
    [compact, loadThread],
  );

  if (!live) {
    // No live connection: an admin viewing as somebody, whose chats are theirs alone.
    return <p className="p-4 text-sm text-muted">Chat is private to each person, so it isn&apos;t shown while you&apos;re viewing as somebody else.</p>;
  }
  if (error) return <p className="p-4 text-sm text-danger">{error}</p>;
  if (!boot) {
    return (
      <div className="grid h-40 place-items-center text-muted">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="Opening chat" />
      </div>
    );
  }

  const active = activeId ? chats.find((c) => c.id === activeId) ?? null : null;
  const thread = activeId ? threads[activeId] ?? null : null;
  const showList = !compact || !activeId;
  const showThread = !!activeId;

  return (
    <div
      className={cn(
        "flex min-h-0 overflow-hidden bg-surface",
        compact ? "h-full flex-col" : "h-[calc(100dvh-8.5rem)] min-h-[420px] rounded-card border border-line md:h-[calc(100dvh-10rem)]",
      )}
    >
      {showList && (
        <div className={cn("flex min-h-0 flex-col", compact ? "flex-1" : cn("w-full border-r border-line md:w-80 md:shrink-0", activeId && "hidden md:flex"))}>
          <ChatList boot={boot} chats={chats} activeId={activeId} typing={typing} onOpen={open} onStarted={(id) => { void refreshRows([id]); open(id); }} />
        </div>
      )}
      {showThread && (
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", !compact && !activeId && "hidden md:flex")}>
          {active && thread ? (
            <ChatThread
              key={active.id}
              boot={boot}
              chat={active}
              thread={thread}
              typing={typing[active.id] ?? []}
              compact={compact}
              onBack={() => open(null)}
              onThread={(next) => setThreads((t) => ({ ...t, [active.id]: next(t[active.id] ?? thread) }))}
              onSent={(m) => {
                setThreads((t) => {
                  const current = t[active.id];
                  if (!current || current.messages.some((x) => x.id === m.id)) return t;
                  return { ...t, [active.id]: { ...current, messages: [...current.messages, m] } };
                });
                setChats((list) => sortRows(list.map((c) => (c.id === active.id ? { ...c, preview: previewLine(m, c.kind === "GROUP", true), lastMessageAt: m.createdAt } : c))));
              }}
              onLeft={() => {
                void refreshRows([active.id]);
                void loadThread(active.id);
              }}
            />
          ) : (
            <div className="grid flex-1 place-items-center text-muted">
              <Loader2 className="h-5 w-5 animate-spin" aria-label="Opening the chat" />
            </div>
          )}
        </div>
      )}
      {!compact && !activeId && (
        <div className="hidden flex-1 flex-col items-center justify-center gap-1 p-8 text-center md:flex">
          <p className="text-sm font-medium text-text">Pick a chat, or start one</p>
          <p className="max-w-sm text-xs text-muted">Messages and files stay inside your workspace. Only the people in a chat can read it.</p>
        </div>
      )}
    </div>
  );
}

function mergeRows(list: ChatSummary[], rows: ChatSummary[]): ChatSummary[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const merged = list.map((c) => byId.get(c.id) ?? c);
  for (const r of rows) if (!list.some((c) => c.id === r.id)) merged.push(r);
  return sortRows(merged);
}

function sortRows(list: ChatSummary[]): ChatSummary[] {
  return [...list].sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

function previewLine(m: ChatMessageView, group: boolean, mine: boolean): string {
  return previewOf({ kind: m.kind, body: m.body, deletedAt: m.deletedAt, attachmentCount: m.attachments.length, senderName: m.senderName }, { group, mine });
}
