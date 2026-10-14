"use client";

import Link from "next/link";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CornerUpLeft,
  Download,
  FileText,
  Info,
  LogOut,
  MoreVertical,
  Paperclip,
  Pencil,
  SendHorizontal,
  Smile,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  chatTyping,
  deleteChatMessage,
  editChatMessage,
  leaveGroupChat,
  loadEarlierMessages,
  muteChat,
  resolveChatRecordLinks,
  sendChatMessage,
  type ChatBootstrap,
  type ChatRecordCard,
} from "@/actions/chat";
import { Avatar } from "@/components/ui/avatar";
import { IconButton } from "@/components/ui/icon-button";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useClock } from "@/components/time/clock-provider";
import { useChatLive } from "@/components/chat/chat-live";
import { GroupInfoDialog } from "@/components/chat/chat-dialogs";
import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MAX_BODY,
  MAX_FILES,
  MAX_FILES_BYTES,
  MUTE_CHOICES,
  chatFileType,
  fileSizeLabel,
  isMuted,
  isPicture,
  opensInBrowser,
  readBy,
  recordLinksIn,
  tickFor,
} from "@/lib/chat/rules";
import type { ChatMemberView, ChatMessageView, ChatSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

export type ThreadState = {
  members: ChatMemberView[];
  messages: ChatMessageView[];
  hasMore: boolean;
  /** A search result being shown: scrolled to and lit up once. */
  highlight: string | null;
};

/** The time, refreshed every so often — for the edit window and "last seen", without reading the clock while drawing. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Keeps an empty subtitle its height. */
const NBSP = String.fromCharCode(160);

/** Messages from one person within this long of each other sit together under one name. */
const RUN_MS = 5 * 60_000;

export function ChatThread({
  boot,
  chat,
  thread,
  typing,
  compact,
  onBack,
  onThread,
  onSent,
  onLeft,
}: {
  boot: ChatBootstrap;
  chat: ChatSummary;
  thread: ThreadState;
  typing: { userId: string; name: string }[];
  compact: boolean;
  onBack: () => void;
  onThread: (update: (t: ThreadState) => ThreadState) => void;
  onSent: (message: ChatMessageView) => void;
  onLeft: () => void;
}) {
  const clock = useClock();
  const live = useChatLive();
  const now = useNow(30_000);
  const meId = boot.me.id;
  const [replyTo, setReplyTo] = useState<ChatMessageView | null>(null);
  const [editing, setEditing] = useState<ChatMessageView | null>(null);
  const [info, setInfo] = useState(false);
  const [cards, setCards] = useState<Record<string, ChatRecordCard>>({});
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const keepFromBottom = useRef<number | null>(null);
  const stuckToBottom = useRef(true);

  const currentMembers = useMemo(() => thread.members.filter((m) => !m.leftAt), [thread.members]);
  const names = useMemo(() => new Map(thread.members.map((m) => [m.userId, m.name])), [thread.members]);
  const other = chat.kind === "DIRECT" ? thread.members.find((m) => m.userId !== meId) ?? null : null;
  const otherOnline = other ? live?.online.has(other.userId) : false;
  const otherLastSeen = other ? live?.lastSeen[other.userId] ?? boot.lastSeen[other.userId] ?? null : null;
  const canWrite = !chat.left && (chat.kind === "GROUP" || chat.otherActive);

  // Record cards: what each link is, for me — fetched once per address.
  const paths = useMemo(() => [...new Set(thread.messages.flatMap((m) => recordLinksIn(m.body).map((l) => l.path)))], [thread.messages]);
  useEffect(() => {
    const missing = paths.filter((p) => !cards[p]);
    if (missing.length === 0) return;
    let cancelled = false;
    void resolveChatRecordLinks(missing)
      .then((found) => {
        if (!cancelled) setCards((c) => ({ ...c, ...Object.fromEntries(found.map((f) => [f.path, f])) }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paths, cards]);

  // Keep the view at the bottom as messages arrive, unless the reader has scrolled up to read back;
  // keep it where it was when earlier messages are put above.
  const count = thread.messages.length;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keepFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - keepFromBottom.current;
      keepFromBottom.current = null;
    } else if (thread.highlight) {
      document.getElementById(`chat-msg-${thread.highlight}`)?.scrollIntoView({ block: "center" });
    } else if (stuckToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [count, thread.highlight]);

  const earlier = async () => {
    const oldest = thread.messages[0];
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const page = await loadEarlierMessages(chat.id, oldest.createdAt);
      const el = scroller.current;
      if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
      onThread((t) => ({ ...t, messages: [...page.messages.filter((m) => !t.messages.some((x) => x.id === m.id)), ...t.messages], hasMore: page.hasMore }));
    } finally {
      setLoadingEarlier(false);
    }
  };

  const subtitle = (() => {
    if (typing.length > 0) return chat.kind === "GROUP" ? `${typing.map((t) => t.name.split(/\s+/)[0]).join(", ")} ${typing.length > 1 ? "are" : "is"} typing…` : "typing…";
    if (chat.kind === "GROUP") return currentMembers.map((m) => (m.userId === meId ? "You" : m.name.split(/\s+/)[0])).join(", ");
    if (!chat.otherActive) return "Account switched off";
    if (otherOnline) return "Online";
    if (otherLastSeen) return clock.dateKey(new Date(otherLastSeen)) === clock.today() ? `Last seen today at ${clock.time(otherLastSeen)}` : `Last seen ${clock.dayMonth(otherLastSeen)} at ${clock.time(otherLastSeen)}`;
    return "";
  })();
  const muted = isMuted(chat.mutedUntil, now);

  return (
    <>
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-2 md:px-3">
        <button
          type="button"
          onClick={onBack}
          className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text", !compact && "md:hidden")}
          aria-label="Back to chats"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="relative shrink-0">
          {chat.kind === "GROUP" ? (
            <span className="grid h-9 w-9 place-items-center rounded-full bg-surface-sunken text-muted">
              <Users className="h-4 w-4" />
            </span>
          ) : (
            <Avatar user={{ id: chat.otherUserId ?? chat.id, name: chat.title, photoUpdatedAt: chat.otherPhotoUpdatedAt }} size="md" />
          )}
          {otherOnline && <span className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full bg-success ring-2 ring-surface" />}
        </span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => chat.kind === "GROUP" && setInfo(true)} disabled={chat.kind !== "GROUP"}>
          <span className="block truncate text-sm font-semibold text-text">{chat.title}</span>
          <span className={cn("block truncate text-[11px]", typing.length ? "italic text-brand" : "text-muted")}>{subtitle || NBSP}</span>
        </button>
        <Menu label={`More for ${chat.title}`} icon={MoreVertical} width={220}>
          {(close) => (
            <>
              {chat.kind === "GROUP" && (
                <MenuItem onClick={() => (close(), setInfo(true))}>
                  <Info className="h-3.5 w-3.5" /> Group info
                </MenuItem>
              )}
              {muted ? (
                <MenuItem onClick={() => (close(), void muteChat(chat.id, null))}>
                  <Bell className="h-3.5 w-3.5" /> Unmute
                </MenuItem>
              ) : (
                MUTE_CHOICES.map((c) => (
                  <MenuItem key={c.hours} onClick={() => (close(), void muteChat(chat.id, c.hours))}>
                    <BellOff className="h-3.5 w-3.5" /> Mute for {c.label === "Always" ? "good" : c.label}
                  </MenuItem>
                ))
              )}
              {chat.kind === "GROUP" && !chat.left && (
                <>
                  <MenuSeparator />
                  <MenuItem
                    danger
                    onClick={() => {
                      close();
                      if (window.confirm(`Leave "${chat.title}"? You'll keep what was said until now.`)) void leaveGroupChat(chat.id).then(onLeft);
                    }}
                  >
                    <LogOut className="h-3.5 w-3.5" /> Leave group
                  </MenuItem>
                </>
              )}
            </>
          )}
        </Menu>
      </div>

      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-surface-sunken/40 px-3 py-3 md:px-5"
      >
        {thread.hasMore && (
          <div className="mb-3 text-center">
            <button type="button" onClick={() => void earlier()} disabled={loadingEarlier} className="rounded-full bg-surface px-3 py-1 text-xs text-muted shadow-sm hover:text-text">
              {loadingEarlier ? "Loading…" : "Load earlier messages"}
            </button>
          </div>
        )}
        {thread.messages.length === 0 && <p className="py-10 text-center text-sm text-muted">No messages yet. Say hello.</p>}
        {thread.messages.map((m, i) => {
          const prev = thread.messages[i - 1];
          const newDay = !prev || clock.dateKey(new Date(prev.createdAt)) !== clock.dateKey(new Date(m.createdAt));
          const startsRun = newDay || !prev || prev.kind !== "TEXT" || prev.senderId !== m.senderId || new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > RUN_MS;
          return (
            <Fragment key={m.id}>
              {newDay && (
                <div className="my-3 text-center">
                  <span className="rounded-full bg-surface px-2.5 py-0.5 text-[11px] text-muted shadow-sm">{dayLabel(clock, m.createdAt, now)}</span>
                </div>
              )}
              {m.kind === "SYSTEM" ? (
                <p className="my-2 text-center text-[11px] text-muted">{m.body}</p>
              ) : (
                <MessageBubble
                  message={m}
                  mine={m.senderId === meId}
                  group={chat.kind === "GROUP"}
                  showName={startsRun}
                  members={thread.members}
                  names={names}
                  meId={meId}
                  cards={cards}
                  now={now}
                  viewOnly={boot.attachmentsViewOnly}
                  highlighted={thread.highlight === m.id}
                  canAct={canWrite}
                  onReply={() => {
                    setEditing(null);
                    setReplyTo(m);
                  }}
                  onEdit={() => {
                    setReplyTo(null);
                    setEditing(m);
                  }}
                  onDelete={() => {
                    if (!window.confirm("Delete this message for everyone?")) return;
                    void deleteChatMessage(m.id).then((res) => {
                      if (res.ok) onThread((t) => ({ ...t, messages: t.messages.map((x) => (x.id === m.id ? res.data : x)) }));
                      else window.alert(res.error);
                    });
                  }}
                />
              )}
            </Fragment>
          );
        })}
      </div>

      {canWrite ? (
        <Composer
          chat={chat}
          members={currentMembers.filter((m) => m.userId !== meId)}
          replyTo={replyTo}
          editing={editing}
          names={names}
          onCancelReply={() => setReplyTo(null)}
          onCancelEdit={() => setEditing(null)}
          onSent={(m) => {
            stuckToBottom.current = true;
            setReplyTo(null);
            onSent(m);
          }}
          onEdited={(m) => {
            setEditing(null);
            onThread((t) => ({ ...t, messages: t.messages.map((x) => (x.id === m.id ? m : x)) }));
          }}
        />
      ) : (
        <p className="shrink-0 border-t border-line px-4 py-3 text-center text-xs text-muted">
          {chat.left ? "You're no longer in this group, so you can't send to it." : `${chat.title}'s account is switched off, so they can't receive messages.`}
        </p>
      )}

      {info && chat.kind === "GROUP" && <GroupInfoDialog open={info} onClose={() => setInfo(false)} boot={boot} chat={chat} members={thread.members} />}
    </>
  );
}

function dayLabel(clock: ReturnType<typeof useClock>, iso: string, now: number): string {
  const key = clock.dateKey(new Date(iso));
  if (key === clock.dateKey(new Date(now))) return "Today";
  if (key === clock.dateKey(new Date(now - 86_400_000))) return "Yesterday";
  return clock.date(iso);
}

// ─── One message ──────────────────────────────────────────────────────────────────────────────────

function MessageBubble({
  message: m,
  mine,
  group,
  showName,
  members,
  names,
  meId,
  cards,
  now,
  viewOnly,
  highlighted,
  canAct,
  onReply,
  onEdit,
  onDelete,
}: {
  message: ChatMessageView;
  mine: boolean;
  group: boolean;
  showName: boolean;
  members: ChatMemberView[];
  names: Map<string, string>;
  meId: string;
  cards: Record<string, ChatRecordCard>;
  now: number;
  viewOnly: boolean;
  highlighted: boolean;
  canAct: boolean;
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const clock = useClock();
  const deleted = !!m.deletedAt;
  const age = now - new Date(m.createdAt).getTime();
  const tick = mine && !deleted ? tickFor(m, members) : null;
  const readers = mine && group && !deleted ? readBy(m, members).map((id) => names.get(id) ?? "Someone") : [];
  const links = deleted ? [] : recordLinksIn(m.body);
  const mentionsMe = m.mentionIds.includes(meId);

  return (
    <div id={`chat-msg-${m.id}`} className={cn("group flex", mine ? "justify-end" : "justify-start", showName ? "mt-2" : "mt-0.5")}>
      <div className={cn("relative max-w-[85%] md:max-w-[70%]", mine ? "items-end" : "items-start")}>
        <div
          className={cn(
            "rounded-card px-3 py-1.5 text-[13px] leading-relaxed shadow-sm",
            mine ? "bg-brand-subtle text-text" : "bg-surface text-text",
            mentionsMe && !mine && "ring-1 ring-brand/40",
            highlighted && "animate-pulse ring-2 ring-brand",
          )}
        >
          {group && !mine && showName && <p className="mb-0.5 text-[11px] font-semibold text-brand">{m.senderName ?? "Former colleague"}</p>}
          {m.replyTo && (
            <a href={`#chat-msg-${m.replyTo.id}`} className="mb-1 block rounded-base border-l-2 border-brand bg-black/5 px-2 py-1 text-xs text-muted dark:bg-white/5">
              <span className="block font-medium text-text">{m.replyTo.senderName ?? "A message"}</span>
              <span className="line-clamp-2">
                {m.replyTo.deleted ? "This message was deleted" : m.replyTo.body || (m.replyTo.attachmentCount ? "A file" : "")}
              </span>
            </a>
          )}
          {deleted ? (
            <p className="italic text-muted">{mine ? "You deleted this message" : "This message was deleted"}</p>
          ) : (
            <>
              {m.attachments.length > 0 && <Attachments attachments={m.attachments} viewOnly={viewOnly} />}
              {m.body && <p className="whitespace-pre-wrap break-words">{renderBody(m.body, members)}</p>}
              {links.map((l) => {
                const card = cards[l.path];
                return card?.allowed ? (
                  <Link key={l.path} href={l.path} className="mt-1 block rounded-base border border-line bg-surface px-2 py-1.5 text-xs hover:border-brand">
                    <span className="block text-[10px] uppercase tracking-wide text-subtle">{l.kind === "companies" ? "Company" : l.kind === "leads" ? "Lead" : l.kind === "orders" ? "Order" : "Ticket"}</span>
                    <span className="block truncate font-medium text-text">{card.title}</span>
                    {card.subtitle && <span className="block truncate text-muted">{card.subtitle}</span>}
                  </Link>
                ) : card ? (
                  <span key={l.path} className="mt-1 block rounded-base border border-dashed border-line px-2 py-1.5 text-xs text-muted">
                    A record you can&apos;t open
                  </span>
                ) : null;
              })}
            </>
          )}
          <span className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-subtle">
            {m.editedAt && !deleted && <span>edited</span>}
            <time dateTime={m.createdAt}>{clock.time(m.createdAt)}</time>
            {tick && (
              <span title={tick === "read" ? (group ? `Read by ${readers.join(", ")}` : "Read") : tick === "delivered" ? "Delivered" : "Sent"}>
                {tick === "sent" ? (
                  <Check className="h-3 w-3" aria-label="Sent" />
                ) : (
                  <CheckCheck className={cn("h-3 w-3", tick === "read" && "text-info")} aria-label={tick === "read" ? "Read" : "Delivered"} />
                )}
              </span>
            )}
          </span>
        </div>
        {!deleted && canAct && (
          <div className={cn("absolute top-0 hidden gap-0.5 rounded-base bg-surface p-0.5 shadow-sm group-focus-within:flex group-hover:flex", mine ? "right-full mr-1" : "left-full ml-1")}>
            <IconButton icon={CornerUpLeft} label="Reply" onClick={onReply} />
            {mine && age < EDIT_WINDOW_MS && m.body && <IconButton icon={Pencil} label="Edit" onClick={onEdit} />}
            {mine && age < DELETE_WINDOW_MS && <IconButton icon={Trash2} label="Delete for everyone" tone="danger" onClick={onDelete} />}
          </div>
        )}
      </div>
    </div>
  );
}

/** Links that work and @names that stand out; everything else as typed. */
function renderBody(body: string, members: ChatMemberView[]): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const linkPattern = /(https?:\/\/[^\s<]+[^\s<.,;:!?)]|\/(?:companies|leads|orders|tickets)\/[A-Za-z0-9-]+)/g;
  let last = 0;
  let key = 0;
  for (const match of body.matchAll(linkPattern)) {
    const at = match.index ?? 0;
    if (at > last) nodes.push(...withMentions(body.slice(last, at), members, () => key++));
    const url = match[0];
    nodes.push(
      url.startsWith("/") ? (
        <Link key={`l${key++}`} href={url} className="text-brand underline underline-offset-2">
          {url}
        </Link>
      ) : (
        <a key={`l${key++}`} href={url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-brand underline underline-offset-2">
          {url}
        </a>
      ),
    );
    last = at + url.length;
  }
  if (last < body.length) nodes.push(...withMentions(body.slice(last), members, () => key++));
  return nodes;
}

function withMentions(text: string, members: ChatMemberView[], nextKey: () => number): React.ReactNode[] {
  const names = members.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0 || !text.includes("@")) return [text];
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`@(${escaped.join("|")})`, "gi");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <span key={`m${nextKey()}`} className="font-medium text-brand">
        {match[0]}
      </span>,
    );
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Attachments({ attachments, viewOnly }: { attachments: ChatMessageView["attachments"]; viewOnly: boolean }) {
  const pictures = attachments.filter((a) => isPicture(a.mimeType));
  const others = attachments.filter((a) => !isPicture(a.mimeType));
  return (
    <div className="mb-1 space-y-1">
      {pictures.length > 0 && (
        <div className={cn("grid gap-1", pictures.length > 1 && "grid-cols-2")}>
          {pictures.map((a) => (
            <a key={a.id} href={`/api/chat/files/${a.id}`} target="_blank" rel="noopener" title={a.fileName}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind a session check, not an optimisable asset */}
              <img src={`/api/chat/files/${a.id}`} alt={a.fileName} className="max-h-56 w-full rounded-base object-cover" loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {others.map((a) => {
        const viewable = opensInBrowser(a.mimeType);
        return (
          <div key={a.id} className="flex items-center gap-2 rounded-base border border-line bg-surface px-2 py-1.5">
            <FileText className="h-4 w-4 shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-text">{a.fileName}</span>
              <span className="block text-[10px] text-subtle">{fileSizeLabel(a.size)}</span>
            </span>
            {viewable && (
              <a href={`/api/chat/files/${a.id}`} target="_blank" rel="noopener" className="text-xs text-brand hover:underline">
                Open
              </a>
            )}
            {!viewOnly ? (
              <a href={`/api/chat/files/${a.id}?download=1`} className="grid h-6 w-6 place-items-center rounded-base text-muted hover:bg-surface-sunken hover:text-text" aria-label={`Download ${a.fileName}`} title="Download">
                <Download className="h-3.5 w-3.5" />
              </a>
            ) : (
              !viewable && <span className="text-[10px] text-subtle">View-only</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Writing ──────────────────────────────────────────────────────────────────────────────────────

const EMOJI = ["😀", "😂", "😊", "😍", "🙂", "😉", "😎", "🤔", "😅", "😢", "😮", "😡", "👍", "👎", "👏", "🙏", "💪", "🤝", "👌", "✌️", "🙌", "👀", "🎉", "🎂", "❤️", "🔥", "⭐", "✅", "❌", "⚠️", "📌", "📎", "📞", "📧", "📅", "⏰", "💡", "🚀", "💯", "☕"];

/** How often "is typing…" is sent while somebody keeps typing. */
const TYPING_EVERY_MS = 3000;

function Composer({
  chat,
  members,
  replyTo,
  editing,
  names,
  onCancelReply,
  onCancelEdit,
  onSent,
  onEdited,
}: {
  chat: ChatSummary;
  members: ChatMemberView[];
  replyTo: ChatMessageView | null;
  editing: ChatMessageView | null;
  names: Map<string, string>;
  onCancelReply: () => void;
  onCancelEdit: () => void;
  onSent: (m: ChatMessageView) => void;
  onEdited: (m: ChatMessageView) => void;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  // Editing puts the message's text in the box; finishing or cancelling empties it.
  const [editingId, setEditingId] = useState<string | null>(null);
  if ((editing?.id ?? null) !== editingId) {
    setEditingId(editing?.id ?? null);
    setText(editing ? editing.body : "");
    setFiles([]);
  }
  useEffect(() => {
    if (editing || replyTo) box.current?.focus();
  }, [editing, replyTo]);

  // The box grows with what is written, up to six lines.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 6 * 22 + 16)}px`;
  }, [text]);

  const candidates = mention ? members.filter((m) => m.name.toLowerCase().startsWith(mention.query.toLowerCase()) || m.name.toLowerCase().includes(` ${mention.query.toLowerCase()}`)).slice(0, 6) : [];

  const onChange = (value: string, caret: number) => {
    setText(value);
    setError(null);
    if (chat.kind === "GROUP") {
      const before = value.slice(0, caret);
      const match = /(^|\s)@([^\s@]{0,30})$/.exec(before);
      setMention(match ? { query: match[2]!, start: caret - match[2]!.length - 1 } : null);
    }
    if (value.trim() && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
      lastTyping.current = Date.now();
      void chatTyping(chat.id).catch(() => {});
    }
  };

  const pickMention = (name: string) => {
    if (!mention) return;
    const el = box.current;
    const caret = el?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const at = mention.start + name.length + 2;
      el?.focus();
      el?.setSelectionRange(at, at);
    });
  };

  const insert = (value: string) => {
    const el = box.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(`${text.slice(0, start)}${value}${text.slice(end)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + value.length, start + value.length);
    });
  };

  const addFiles = (incoming: FileList | File[]) => {
    const list = [...files, ...Array.from(incoming)];
    if (list.length > MAX_FILES) return setError(`Up to ${MAX_FILES} files at a time.`);
    if (list.reduce((t, f) => t + f.size, 0) > MAX_FILES_BYTES) return setError("Files can come to 5 MB at most on one message.");
    const refused = list.find((f) => !chatFileType(f.type, f.name));
    if (refused) return setError(`"${refused.name}" isn't a kind of file chat takes.`);
    setError(null);
    setFiles(list);
  };

  const submit = async () => {
    const body = text.trim();
    if (busy) return;
    if (editing) {
      if (!body) return setError("A message can't be empty — delete it instead.");
      setBusy(true);
      const res = await editChatMessage(editing.id, body).catch(() => null);
      setBusy(false);
      if (!res) return setError("That didn't send — check your connection.");
      if (!res.ok) return setError(res.error);
      setText("");
      onEdited(res.data);
      return;
    }
    if (!body && files.length === 0) return;
    if (body.length > MAX_BODY) return setError(`Messages can be up to ${MAX_BODY.toLocaleString("en-IN")} characters.`);
    const form = new FormData();
    form.set("chatId", chat.id);
    form.set("body", body);
    if (replyTo) form.set("replyToId", replyTo.id);
    for (const f of files) form.append("files", f);
    setBusy(true);
    const res = await sendChatMessage(form).catch(() => null);
    setBusy(false);
    if (!res) return setError("That didn't send — check your connection.");
    if (!res.ok) return setError(res.error);
    setText("");
    setFiles([]);
    setMention(null);
    onSent(res.data);
    box.current?.focus();
  };

  return (
    <div className="relative shrink-0 border-t border-line bg-surface p-2">
      {(replyTo || editing) && (
        <div className="mb-2 flex items-start gap-2 rounded-base border-l-2 border-brand bg-surface-sunken px-2 py-1.5 text-xs">
          <span className="min-w-0 flex-1">
            <span className="block font-medium text-text">{editing ? "Editing your message" : `Replying to ${replyTo!.senderName ?? names.get(replyTo!.senderId ?? "") ?? "a message"}`}</span>
            <span className="line-clamp-1 text-muted">{(editing ?? replyTo)!.body || "A file"}</span>
          </span>
          <button type="button" onClick={editing ? onCancelEdit : onCancelReply} className="text-muted hover:text-text" aria-label="Cancel">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <ul role="list" className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1 rounded-full bg-surface-sunken py-0.5 pl-2 pr-1 text-[11px] text-text">
              <Paperclip className="h-3 w-3 text-muted" />
              <span className="max-w-40 truncate">{f.name}</span>
              <span className="text-subtle">{fileSizeLabel(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))} className="grid h-4 w-4 place-items-center rounded-full hover:bg-surface">
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {mention && candidates.length > 0 && (
        <ul role="listbox" aria-label="Mention somebody" className="absolute bottom-full left-2 z-10 mb-1 w-64 overflow-hidden rounded-base border border-line bg-surface shadow-lg">
          {candidates.map((m) => (
            <li key={m.userId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickMention(m.name)}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-sunken"
              >
                <Avatar user={{ id: m.userId, name: m.name, photoUpdatedAt: m.photoUpdatedAt }} size="xs" />
                {m.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {emoji && (
        <div className="absolute bottom-full left-2 z-10 mb-1 grid w-72 grid-cols-8 gap-0.5 rounded-base border border-line bg-surface p-1.5 shadow-lg" role="dialog" aria-label="Emoji">
          {EMOJI.map((e) => (
            <button key={e} type="button" onClick={() => insert(e)} className="grid h-8 w-8 place-items-center rounded-base text-lg hover:bg-surface-sunken">
              {e}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <IconButton icon={Smile} label={emoji ? "Close emoji" : "Emoji"} onClick={() => setEmoji((v) => !v)} className="mb-1" />
        {!editing && (
          <>
            <IconButton icon={Paperclip} label="Attach files" onClick={() => fileInput.current?.click()} className="mb-1" />
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.txt,.log,.csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </>
        )}
        <label className="min-w-0 flex-1">
          <span className="sr-only">Message</span>
          <textarea
            ref={box}
            rows={1}
            value={text}
            maxLength={MAX_BODY}
            placeholder={chat.kind === "GROUP" ? "Message the group — @ to mention" : "Message"}
            onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
            onPaste={(e) => {
              if (!editing && e.clipboardData.files.length > 0) {
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (mention && candidates.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                pickMention(candidates[0]!.name);
                return;
              }
              if (e.key === "Escape") {
                setMention(null);
                setEmoji(false);
                if (editing) onCancelEdit();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            className="block max-h-40 w-full resize-none rounded-card border border-line bg-surface-sunken px-3 py-2 text-[13px] leading-[22px] text-text placeholder:text-subtle focus:border-brand focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || (!text.trim() && files.length === 0)}
          aria-label={editing ? "Save" : "Send"}
          title={editing ? "Save" : "Send"}
          className="mb-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-brand-contrast transition-[filter] hover:brightness-110 disabled:opacity-40"
        >
          {editing ? <Check className="h-4 w-4" /> : <SendHorizontal className="h-4 w-4" />}
        </button>
      </div>
      {error && <p className="mt-1 px-1 text-xs text-danger">{error}</p>}
    </div>
  );
}
