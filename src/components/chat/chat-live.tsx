"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { chatUnreadCount } from "@/actions/chat";
import { listenForFirstGesture, playChime } from "@/components/notifications/chime";
import type { ChatEvent } from "@/lib/chat/types";

/**
 * Chat's one live connection, for the whole app: the header's button, the rail's panel and the chat
 * page all listen to it, so a person with Deskzo open has one stream however many of those are on
 * screen (src/app/api/chat/stream).
 *
 * It also keeps the unread count and makes the sound: a new message in a chat that isn't muted — or
 * one that @mentions you, muted or not — chimes unless you are looking at that chat right now.
 */

type Listener = (event: ChatEvent) => void;

type ChatLive = {
  meId: string;
  connected: boolean;
  online: ReadonlySet<string>;
  lastSeen: Readonly<Record<string, string>>;
  unread: number;
  setUnread: (total: number) => void;
  subscribe: (listener: Listener) => () => void;
  /**
   * The chat on screen and in front of the person, if any — set by the chat screen. Clearing passes the
   * chat being left, so a screen closing never clears another's.
   */
  setViewing: (chatId: string | null, leaving?: string | null) => void;
};

const ChatLiveContext = createContext<ChatLive | null>(null);

/** Null outside the provider: chat isn't open to this person (or they are viewing as somebody). */
export function useChatLive(): ChatLive | null {
  return useContext(ChatLiveContext);
}

export function ChatLiveProvider({ meId, initialUnread, children }: { meId: string; initialUnread: number; children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [unread, setUnread] = useState(initialUnread);
  const listeners = useRef(new Set<Listener>());
  const viewing = useRef<string | null>(null);

  const setViewing = useCallback((chatId: string | null, leaving?: string | null) => {
    if (chatId !== null || leaving === undefined || viewing.current === leaving) viewing.current = chatId;
  }, []);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => listenForFirstGesture(), []);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const handle = (event: ChatEvent) => {
      if (event.type === "ready") {
        setConnected(true);
        setOnline(new Set(event.online));
        // Whatever arrived while the line was down.
        void chatUnreadCount().then(setUnread).catch(() => {});
      } else if (event.type === "presence") {
        setOnline((prev) => {
          const next = new Set(prev);
          if (event.online) next.add(event.userId);
          else next.delete(event.userId);
          return next;
        });
        if (event.lastSeenAt) setLastSeen((prev) => ({ ...prev, [event.userId]: event.lastSeenAt! }));
      } else if (event.type === "unread") {
        setUnread(event.total);
      } else if (event.type === "message") {
        const m = event.message;
        const fromOther = m.kind === "TEXT" && m.senderId !== meId;
        const looking = viewing.current === m.chatId && document.visibilityState === "visible" && document.hasFocus();
        if (fromOther && !looking && (!event.muted || event.mentioned)) {
          setUnread((u) => u + 1);
          playChime();
        }
      }
      for (const listener of listeners.current) listener(event);
    };

    const open = () => {
      if (stopped) return;
      source = new EventSource("/api/chat/stream");
      source.onmessage = (e) => {
        try {
          handle(JSON.parse(e.data) as ChatEvent);
        } catch {
          // A malformed line is skipped; the next one is whole.
        }
      };
      source.onerror = () => {
        setConnected(false);
        // EventSource retries a dropped line by itself. A refused one (signed out, switched off) it
        // closes: try again in a minute, by which time the page has probably moved on.
        if (source?.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(open, 60_000);
        }
      };
    };
    open();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [meId]);

  const value = useMemo<ChatLive>(
    () => ({ meId, connected, online, lastSeen, unread, setUnread, subscribe, setViewing }),
    [meId, connected, online, lastSeen, unread, subscribe, setViewing],
  );
  return <ChatLiveContext.Provider value={value}>{children}</ChatLiveContext.Provider>;
}

/** Every chat event, for as long as the calling component is on screen. */
export function useChatEvents(listener: Listener) {
  const live = useChatLive();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    if (!live) return;
    return live.subscribe((event) => latest.current(event));
  }, [live?.subscribe]); // eslint-disable-line react-hooks/exhaustive-deps
}
