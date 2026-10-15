"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { chatUnreadCount } from "@/actions/chat";
import { listenForFirstGesture, playChime } from "@/components/notifications/chime";
import { SOUNDS_CHANGED_EVENT, chatChimes, parseReminderSounds } from "@/lib/reminder-sounds";
import type { ChatEvent, ChatMessageView } from "@/lib/chat/types";

/**
 * Chat's one live connection, for the whole app: the header's button, the rail's panel and the chat
 * page all listen to it, so a person with Deskzo open has one stream however many of those are on
 * screen (src/app/api/chat/stream).
 *
 * It also keeps the unread count and tells you: a new message in a chat that isn't muted — or one that
 * @mentions you, muted or not — chimes unless you are looking at that chat right now (the sound can be
 * switched off under Notifications), and, with Deskzo in the background and desktop alerts on for this
 * browser, puts up an alert that says who and where, never what.
 */

/** Asks the chat screen to open a chat — an alert clicked while it is already on screen. */
export const CHAT_OPEN_EVENT = "deskzo.chat-open";

// ─── Desktop alerts ───────────────────────────────────────────────────────────────────────────────

/** This browser's choice, on top of its permission: "off" silences alerts here without revoking it. */
const ALERTS_KEY = "deskzo.chat.alerts";
const ALERTS_CHANGED = "deskzo.chat.alerts-changed";

export type DesktopAlerts = "unsupported" | "ask" | "on" | "off" | "blocked";

function alertsState(): DesktopAlerts {
  if (typeof window === "undefined" || typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission === "default") return "ask";
  try {
    return window.localStorage.getItem(ALERTS_KEY) === "off" ? "off" : "on";
  } catch {
    return "on";
  }
}

function subscribeAlerts(onChange: () => void) {
  window.addEventListener(ALERTS_CHANGED, onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener("focus", onChange);
  return () => {
    window.removeEventListener(ALERTS_CHANGED, onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener("focus", onChange);
  };
}

/** Desktop alerts in this browser, and the one switch for them: asks the browser the first time. */
export function useDesktopAlerts(): { state: DesktopAlerts; toggle: () => void } {
  const state = useSyncExternalStore(subscribeAlerts, alertsState, () => "unsupported" as const);
  const toggle = useCallback(() => {
    const now = alertsState();
    const changed = () => window.dispatchEvent(new Event(ALERTS_CHANGED));
    if (now === "ask") {
      void Notification.requestPermission().then(changed);
      return;
    }
    try {
      if (now === "on") window.localStorage.setItem(ALERTS_KEY, "off");
      else if (now === "off") window.localStorage.removeItem(ALERTS_KEY);
    } catch {
      // Storage off: the browser's permission alone decides.
    }
    changed();
  }, []);
  return { state, toggle };
}

/** "Priya Sharma" / "New message" — who and where, never what was said. */
function alertFor(m: ChatMessageView, chatTitle: string | null | undefined, mentioned: boolean): { title: string; body: string } {
  const sender = m.senderName ?? "Somebody";
  const group = !!chatTitle && chatTitle !== m.senderName;
  const what = mentioned ? "mentioned you" : m.attachments.length && !m.body ? "sent a file" : "sent a message";
  return group ? { title: chatTitle!, body: `${sender.split(/\s+/)[0]} ${what}` } : { title: sender, body: what.charAt(0).toUpperCase() + what.slice(1) };
}

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

export function ChatLiveProvider({ meId, initialUnread, sound, children }: { meId: string; initialUnread: number; sound: boolean; children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  // Read by the stream's handler, which outlives renders: the latest of each, kept in refs.
  const soundOn = useRef(sound);
  const where = useRef({ router, pathname });
  useEffect(() => {
    soundOn.current = sound;
    where.current = { router, pathname };
  });
  useEffect(() => {
    const onChange = (e: Event) => {
      if (e instanceof CustomEvent) soundOn.current = chatChimes(parseReminderSounds(e.detail));
    };
    window.addEventListener(SOUNDS_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(SOUNDS_CHANGED_EVENT, onChange);
  }, []);
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
          if (soundOn.current) playChime();
          // Deskzo in the background: an alert from the browser, if this browser wants them.
          const away = document.visibilityState !== "visible" || !document.hasFocus();
          if (away && alertsState() === "on") {
            const { title, body } = alertFor(m, event.chatTitle, event.mentioned);
            try {
              const alert = new Notification(title, { body, tag: `deskzo-chat-${m.chatId}`, silent: soundOn.current });
              alert.onclick = () => {
                window.focus();
                alert.close();
                const { router: r, pathname: p } = where.current;
                if (p === "/chat") window.dispatchEvent(new CustomEvent(CHAT_OPEN_EVENT, { detail: m.chatId }));
                else r.push(`/chat?c=${encodeURIComponent(m.chatId)}`);
              };
            } catch {
              // Some browsers allow alerts only from a service worker; the chime and the count still came.
            }
          }
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
