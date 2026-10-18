import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import { api, signedIn } from "@/lib/api";
import type { ChatBootstrap, ChatEvent, ChatPerson, ChatSummary } from "@/lib/chat-types";
import { openEventStream } from "@/lib/sse";
import { useSession } from "@/lib/session";

/**
 * Team chat across the app (owner, 18 Oct 2026; src/app/api/app/chat on the server): the chat list, who is online,
 * the unread count on the tab, and the live stream while the app is in front — closed when it goes behind, opened
 * again and caught up when it comes back. A conversation listens here for its own chat's events.
 */

type Banner = { chatId: string; title: string };

type ChatState = {
  /** Chat is open to this person (their plan, the switch, their role). */
  available: boolean;
  loaded: boolean;
  me: { id: string; name: string } | null;
  people: ChatPerson[];
  summaries: ChatSummary[];
  online: Set<string>;
  lastSeen: Record<string, string>;
  viewOnly: boolean;
  unread: number;
  banner: Banner | null;
  dismissBanner: () => void;
  refresh: () => Promise<void>;
  reloadSummaries: (ids?: string[]) => Promise<void>;
  /** The conversation on screen, so its messages raise no banner and count as read. */
  setOpenChat: (id: string | null) => void;
  listen: (listener: (event: ChatEvent) => void) => () => void;
};

const Ctx = createContext<ChatState | null>(null);

const isMuted = (until: string | null) => !!until && new Date(until).getTime() > Date.now();
const byLatest = (a: ChatSummary, b: ChatSummary) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? "");

export function ChatProvider({ children }: { children: ReactNode }) {
  const { paired, me: whoAmI } = useSession();
  const available = paired && whoAmI?.can.chat === true;
  const [boot, setBoot] = useState<ChatBootstrap | null>(null);
  const [summaries, setSummaries] = useState<ChatSummary[]>([]);
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [lastSeen, setLastSeen] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<Banner | null>(null);
  const listeners = useRef(new Set<(event: ChatEvent) => void>());
  const openChat = useRef<string | null>(null);
  const meId = useRef<string | null>(null);
  const pending = useRef(new Set<string>());
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const b = await api<ChatBootstrap>("GET", "/api/app/chat");
      meId.current = b.me.id;
      setBoot(b);
      setSummaries([...b.chats].sort(byLatest));
      setOnline(new Set(b.online));
      setLastSeen(b.lastSeen);
    } catch {
      // The list shows what it had; the next refresh tries again.
    }
  }, [available]);

  const reloadSummaries = useCallback(async (ids?: string[]) => {
    try {
      const rows = await api<ChatSummary[]>("GET", `/api/app/chat/summaries${ids?.length ? `?ids=${ids.join(",")}` : ""}`);
      setSummaries((now) => {
        if (!ids?.length) return [...rows].sort(byLatest);
        const fresh = new Map(rows.map((r) => [r.id, r]));
        const kept = now.filter((s) => !fresh.has(s.id));
        return [...kept, ...rows].sort(byLatest);
      });
    } catch {
      // As above.
    }
  }, []);

  // Several messages in a moment: one reload of the rows they touched.
  const touch = useCallback(
    (chatId: string) => {
      pending.current.add(chatId);
      if (pendingTimer.current) return;
      pendingTimer.current = setTimeout(() => {
        const ids = [...pending.current];
        pending.current.clear();
        pendingTimer.current = null;
        void reloadSummaries(ids);
      }, 250);
    },
    [reloadSummaries],
  );

  const handle = useCallback(
    (event: ChatEvent) => {
      switch (event.type) {
        case "ready":
          setOnline(new Set(event.online));
          break;
        case "presence":
          setOnline((now) => {
            const next = new Set(now);
            if (event.online) next.add(event.userId);
            else next.delete(event.userId);
            return next;
          });
          if (event.lastSeenAt) setLastSeen((now) => ({ ...now, [event.userId]: event.lastSeenAt! }));
          break;
        case "message": {
          const { message } = event;
          touch(message.chatId);
          const mine = message.senderId === meId.current;
          // Who and where, never what — as the website's alerts (and a phone's lock screen, later).
          if (!mine && !event.muted && openChat.current !== message.chatId) {
            setBanner({ chatId: message.chatId, title: event.chatTitle ? `New message · ${event.chatTitle}` : "New message" });
          }
          break;
        }
        case "message-updated":
          touch(event.message.chatId);
          break;
        case "chat-changed":
          touch(event.chatId);
          break;
        case "unread":
          void reloadSummaries();
          break;
      }
      listeners.current.forEach((l) => l(event));
    },
    [touch, reloadSummaries],
  );

  // The live stream: open while the app is in front, opened again after a drop.
  useEffect(() => {
    if (!available) return;
    let stop: (() => void) | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let active = AppState.currentState === "active";
    let attempts = 0;

    const connect = () => {
      const where = signedIn();
      if (!where || stop || !active) return;
      stop = openEventStream(`${where.baseUrl}/api/app/chat/stream`, where.headers, {
        open: () => {
          attempts = 0;
        },
        data: (text) => {
          try {
            handle(JSON.parse(text) as ChatEvent);
          } catch {
            // A line that isn't an event.
          }
        },
        end: (status) => {
          stop = null;
          // Signed out, or chat not theirs: no point trying again until something changes.
          if (status === 401 || status === 403) return;
          attempts += 1;
          if (active) retry = setTimeout(connect, Math.min(30_000, 2000 * attempts));
        },
      });
    };

    void refresh().then(connect);
    const sub = AppState.addEventListener("change", (state) => {
      const wasActive = active;
      active = state === "active";
      if (active && !wasActive) {
        // Back in front: catch up on what came while away, and listen again.
        void refresh().then(connect);
      } else if (!active && wasActive) {
        if (retry) clearTimeout(retry);
        stop?.();
        stop = null;
      }
    });
    return () => {
      sub.remove();
      if (retry) clearTimeout(retry);
      stop?.();
    };
  }, [available, refresh, handle]);

  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(t);
  }, [banner]);

  const unread = useMemo(() => summaries.reduce((n, s) => n + (isMuted(s.mutedUntil) ? 0 : s.unread), 0), [summaries]);

  const value = useMemo<ChatState>(
    () => ({
      available,
      loaded: !!boot,
      me: boot?.me ?? null,
      people: boot?.people ?? [],
      summaries,
      online,
      lastSeen,
      viewOnly: boot?.attachmentsViewOnly ?? false,
      unread,
      banner,
      dismissBanner: () => setBanner(null),
      refresh,
      reloadSummaries,
      setOpenChat: (id) => {
        openChat.current = id;
        if (id) setBanner((b) => (b?.chatId === id ? null : b));
      },
      listen: (listener) => {
        listeners.current.add(listener);
        return () => void listeners.current.delete(listener);
      },
    }),
    [available, boot, summaries, online, lastSeen, unread, banner, refresh, reloadSummaries],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChat(): ChatState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useChat outside ChatProvider");
  return value;
}
