"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Bot, Check, CheckCheck, Globe, MessageSquareMore, Phone, Search, Ticket, UserPlus } from "lucide-react";
import {
  inboxAssign,
  inboxConversation,
  inboxList,
  inboxMakeLead,
  inboxMakeTicket,
  inboxReply,
  inboxSendTemplate,
  inboxSetStatus,
} from "@/actions/inbox";
import { useChatLive } from "@/components/chat/chat-live";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { companyPath, ticketPath } from "@/lib/record-links";
import type { InboxDetail, InboxMessage, InboxRow, InboxView } from "@/lib/inbox/server";
import { cn } from "@/lib/utils";

/**
 * The Customer inbox's screen (src/lib/inbox): the conversations on the left — mine, nobody's yet, every
 * open one, or the closed — the one open in the middle with its reply box, and who the customer is, with
 * what can be done about them, on the right. On a phone, the list or the conversation.
 *
 * Live through team chat's connection (src/components/chat/chat-live.tsx), which says only which
 * conversation changed: the list and the open conversation are asked for again. Without it — chat
 * switched off for this person — every fifteen seconds instead.
 */

type Channel = { id: string; name: string; kind: "WEB" | "WHATSAPP" };

const VIEWS: { value: InboxView; label: string }[] = [
  { value: "mine", label: "Mine" },
  { value: "unassigned", label: "Unassigned" },
  { value: "open", label: "All open" },
  { value: "closed", label: "Closed" },
];

function KindIcon({ kind, className }: { kind: "WEB" | "WHATSAPP"; className?: string }) {
  return kind === "WHATSAPP" ? <Phone aria-hidden="true" className={className} /> : <Globe aria-hidden="true" className={className} />;
}

export function InboxApp({
  meId,
  channels,
  people,
  initialRows,
  initialView,
  initialDetail,
  canMakeLead,
  canMakeTicket,
}: {
  meId: string;
  channels: Channel[];
  people: { id: string; name: string }[];
  initialRows: InboxRow[];
  initialView: InboxView;
  initialDetail: InboxDetail | null;
  canMakeLead: boolean;
  canMakeTicket: boolean;
}) {
  const clock = useClock();
  const live = useChatLive();
  const [view, setView] = useState<InboxView>(initialView);
  const [channelId, setChannelId] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<InboxRow[]>(initialRows);
  const [detail, setDetail] = useState<InboxDetail | null>(initialDetail);
  const [selected, setSelected] = useState<string | null>(initialDetail?.id ?? null);
  const [draft, setDraft] = useState("");
  const [template, setTemplate] = useState({ name: "", values: "" });
  const [ticketTitle, setTicketTitle] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const threadEnd = useRef<HTMLDivElement>(null);
  const filters = useRef({ view, channelId, q });
  const selectedRef = useRef(selected);
  useEffect(() => {
    filters.current = { view, channelId, q };
    selectedRef.current = selected;
  });

  const time = useMemo(() => {
    const hm = new Intl.DateTimeFormat("en-IN", { timeZone: clock.zone, hour: "numeric", minute: "2-digit" });
    const day = new Intl.DateTimeFormat("en-IN", { timeZone: clock.zone, day: "numeric", month: "short" });
    return (iso: string) => {
      const at = new Date(iso);
      return clock.dateKey(at) === clock.today() ? hm.format(at) : `${day.format(at)}, ${hm.format(at)}`;
    };
  }, [clock]);

  const reloadList = useCallback(async () => {
    const f = filters.current;
    setRows(await inboxList({ view: f.view, channelId: f.channelId || null, q: f.q || null }));
  }, []);
  const reloadDetail = useCallback(async (id: string | null = selectedRef.current) => {
    if (!id) return;
    const next = await inboxConversation(id);
    if (selectedRef.current === id) setDetail(next);
  }, []);

  // Filters changed: the list again, a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => void reloadList(), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [view, channelId, q, reloadList]);

  // Live: whichever conversation changed, the list — and the open one, if it was that.
  useEffect(() => {
    if (!live) return;
    return live.subscribe((event) => {
      if (event.type !== "inbox") return;
      void reloadList();
      if (event.conversationId === selectedRef.current) void reloadDetail(event.conversationId);
    });
  }, [live, reloadList, reloadDetail]);
  useEffect(() => {
    const every = live?.connected ? 60_000 : 15_000;
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void reloadList();
      void reloadDetail();
    }, every);
    return () => clearInterval(t);
  }, [live?.connected, reloadList, reloadDetail]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [detail?.id, detail?.messages.length]);

  function open(id: string) {
    setSelected(id);
    setError(null);
    setNotice(null);
    setTicketTitle(null);
    setDraft("");
    startTransition(async () => {
      const next = await inboxConversation(id);
      setDetail(next);
      window.history.replaceState(null, "", next ? `/inbox?c=${next.ref}` : "/inbox");
      void reloadList();
    });
  }

  /** Runs a change, then shows the conversation and the list as they now are. */
  function act(work: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void, success?: string) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      after?.();
      if (success) setNotice(success);
      await Promise.all([reloadDetail(), reloadList()]);
    });
  }

  const id = detail?.id ?? null;
  const send = () => id && draft.trim() && act(() => inboxReply(id, draft), () => setDraft(""));
  const sendTemplate = () =>
    id &&
    act(
      () => inboxSendTemplate(id, { name: template.name, variables: template.values.split("\n").map((v) => v.trim()).filter(Boolean) }),
      () => setTemplate({ name: "", values: "" }),
    );

  // ─── The list ──────────────────────────────────────────────────────────────────────────────────
  const list = (
    <section aria-label="Conversations" className={cn("flex min-h-0 flex-col border-line md:w-80 md:shrink-0 md:border-r", detail && "hidden md:flex")}>
      <div className="space-y-2 border-b border-line p-3">
        <div role="tablist" aria-label="Which conversations" className="flex gap-1 rounded-base bg-surface-sunken p-1">
          {VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              role="tab"
              aria-selected={view === v.value}
              onClick={() => setView(v.value)}
              className={cn("flex-1 rounded px-2 py-1 text-xs font-medium", view === v.value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text")}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
            <Input aria-label="Search by name, phone or email" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 pl-8 text-sm" />
          </div>
          {channels.length > 1 && (
            <Select aria-label="Channel" value={channelId} onChange={(e) => setChannelId(e.target.value)} className="h-8 w-32 text-sm">
              <option value="">Every channel</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted">{view === "mine" ? "Nothing of yours waiting." : view === "unassigned" ? "Nothing in the queue." : "No conversations here."}</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => open(r.id)}
              aria-current={selected === r.id ? "true" : undefined}
              className={cn("flex w-full gap-3 border-b border-line px-3 py-2.5 text-left hover:bg-surface-sunken", selected === r.id && "bg-brand-subtle")}
            >
              <span className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full", r.kind === "WHATSAPP" ? "bg-success-bg text-success" : "bg-info-bg text-info")}>
                <KindIcon kind={r.kind} className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", r.unread ? "font-semibold text-text" : "font-medium text-text")}>{r.customer}</span>
                  <span className="shrink-0 text-[11px] text-subtle">{time(r.lastMessageAt)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  {r.unread && <span aria-label="Unread" className="h-2 w-2 shrink-0 rounded-full bg-brand" />}
                  <span className={cn("truncate text-xs", r.unread ? "text-text" : "text-muted")}>
                    {r.lastFrom === "AGENT" ? "You: " : r.lastFrom === "BOT" ? "Bot: " : ""}
                    {r.preview}
                  </span>
                </span>
                <span className="mt-0.5 block truncate text-[11px] text-subtle">
                  {r.channelName}
                  {r.botActive ? " · with the bot" : r.assignedTo ? ` · ${r.assignedTo.id === meId ? "you" : r.assignedTo.name}` : " · nobody yet"}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );

  // ─── A customer's file: fetched from WhatsApp the first time it's opened, then kept ──────────────
  const media = (messageId: string, file: NonNullable<InboxMessage["media"]>) => {
    const src = `/api/inbox/files/${encodeURIComponent(messageId)}`;
    const mime = file.mime ?? "";
    if (/^image\/(jpeg|png|webp|gif)$/.test(mime)) {
      return (
        <a href={src} target="_blank" rel="noopener" className="mt-1.5 block">
          {/* eslint-disable-next-line @next/next/no-img-element -- a private file behind the inbox's own checks, not an optimisable image */}
          <img src={src} alt={file.name ?? "A photo the customer sent"} loading="lazy" className="max-h-56 rounded-lg" />
        </a>
      );
    }
    if (mime.startsWith("audio/")) return <audio controls preload="none" src={src} className="mt-1.5 w-56 max-w-full" />;
    if (mime === "video/mp4" || mime === "video/3gpp") return <video controls preload="none" src={src} className="mt-1.5 max-h-56 max-w-full rounded-lg" />;
    return (
      <a href={`${src}?download=1`} className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2">
        Save {file.name ?? "the file"}
      </a>
    );
  };

  // ─── A message ─────────────────────────────────────────────────────────────────────────────────
  const message = (m: InboxMessage) => {
    if (m.author === "SYSTEM") {
      return (
        <li key={m.id} className="text-center text-[11px] text-subtle">
          {m.body} · {time(m.at)}
        </li>
      );
    }
    const ours = m.author !== "CUSTOMER";
    return (
      <li key={m.id} className={cn("flex", ours ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", ours ? (m.author === "BOT" ? "bg-surface-sunken text-text" : "bg-brand text-brand-contrast") : "border border-line bg-surface text-text")}>
          {ours && (
            <span className={cn("mb-0.5 flex items-center gap-1 text-[11px]", m.author === "BOT" ? "text-muted" : "text-brand-contrast/80")}>
              {m.author === "BOT" ? <Bot aria-hidden="true" className="h-3 w-3" /> : null}
              {m.author === "BOT" ? "Bot" : (m.userName ?? "Us")}
            </span>
          )}
          <p className="whitespace-pre-wrap break-words">{m.body}</p>
          {m.media && media(m.id, m.media)}
          <span className={cn("mt-0.5 flex items-center justify-end gap-1 text-[10px]", ours && m.author !== "BOT" ? "text-brand-contrast/70" : "text-subtle")}>
            {time(m.at)}
            {m.delivery === "SENT" && <Check aria-label="Sent" className="h-3 w-3" />}
            {m.delivery === "DELIVERED" && <CheckCheck aria-label="Delivered" className="h-3 w-3" />}
            {m.delivery === "READ" && <CheckCheck aria-label="Read" className="h-3 w-3 text-sky-300" />}
          </span>
          {m.delivery === "FAILED" && <span className="mt-1 block text-[11px] font-medium text-danger">Not delivered{m.error ? `: ${m.error}` : ""}</span>}
        </div>
      </li>
    );
  };

  // ─── The conversation ──────────────────────────────────────────────────────────────────────────
  const thread = detail ? (
    <section aria-label={`Conversation with ${detail.customer}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <button type="button" className="rounded p-1 text-muted hover:text-text md:hidden" aria-label="Back to the list" onClick={() => setDetail(null)}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <KindIcon kind={detail.kind} className="h-4 w-4 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-text">{detail.customer}</h2>
          <p className="truncate text-xs text-muted">
            {detail.ref} · {detail.channelName}
            {detail.status === "CLOSED" ? " · closed" : ""}
          </p>
        </div>
        {detail.status === "OPEN" ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => inboxSetStatus(detail.id, "CLOSED"))}>
            Close
          </Button>
        ) : (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => inboxSetStatus(detail.id, "OPEN"))}>
            Reopen
          </Button>
        )}
      </header>
      <ol className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-surface-sunken/40 px-3 py-4">
        {detail.messages.map(message)}
        <div ref={threadEnd} />
      </ol>
      {(error || notice) && (
        <p role={error ? "alert" : "status"} className={cn("border-t border-line px-3 py-2 text-xs", error ? "bg-danger-bg text-danger" : "bg-success-bg text-success")}>
          {error ?? notice}
        </p>
      )}
      {detail.botActive && <p className="border-t border-line bg-info-bg px-3 py-1.5 text-xs text-info">The bot is answering. Reply and it steps aside.</p>}
      {detail.windowOpen ? (
        <form
          className="flex items-end gap-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Textarea
            aria-label="Reply"
            rows={2}
            value={draft}
            maxLength={2000}
            placeholder={detail.kind === "WHATSAPP" ? "Reply on WhatsApp" : "Reply in the website chat"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            className="min-h-0 flex-1 resize-none"
          />
          <Button type="submit" disabled={pending || !draft.trim()}>
            Send
          </Button>
        </form>
      ) : (
        <form
          className="space-y-2 border-t border-line p-3"
          onSubmit={(e) => {
            e.preventDefault();
            sendTemplate();
          }}
        >
          <p className="text-xs text-muted">It&apos;s over 24 hours since they last wrote, so WhatsApp only takes an approved template now.</p>
          <div className="grid gap-2 sm:grid-cols-[12rem_1fr_auto] sm:items-end">
            <div>
              <Label htmlFor="inbox-template">Template name</Label>
              <Input id="inbox-template" className="mt-1" value={template.name} onChange={(e) => setTemplate((t) => ({ ...t, name: e.target.value }))} placeholder="order_update" />
            </div>
            <div>
              <Label htmlFor="inbox-template-values">Its values, one a line</Label>
              <Textarea id="inbox-template-values" className="mt-1 min-h-0" rows={2} value={template.values} onChange={(e) => setTemplate((t) => ({ ...t, values: e.target.value }))} />
            </div>
            <Button type="submit" disabled={pending || !template.name.trim()}>
              Send template
            </Button>
          </div>
        </form>
      )}
    </section>
  ) : (
    <section className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted md:flex">
      <MessageSquareMore aria-hidden="true" className="h-8 w-8 text-subtle" />
      <p>Choose a conversation.</p>
    </section>
  );

  // ─── Who they are ──────────────────────────────────────────────────────────────────────────────
  const assignedId = detail?.assignedTo?.id ?? "";
  const details = detail && (
    <aside aria-label="About this customer" className="hidden w-72 shrink-0 space-y-5 overflow-y-auto border-l border-line p-4 text-sm lg:block">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Customer</h3>
        <dl className="mt-2 space-y-1.5">
          {detail.customerName && (
            <div>
              <dt className="sr-only">Name</dt>
              <dd className="font-medium text-text">{detail.customerName}</dd>
            </div>
          )}
          {detail.customerPhone && (
            <div>
              <dt className="sr-only">Phone</dt>
              <dd className="text-muted">{detail.customerPhone}</dd>
            </div>
          )}
          {detail.customerEmail && (
            <div>
              <dt className="sr-only">Email</dt>
              <dd className="break-all text-muted">{detail.customerEmail}</dd>
            </div>
          )}
          {detail.pageUrl && (
            <div>
              <dt className="text-xs text-subtle">Started on</dt>
              <dd className="break-all text-xs text-muted">{detail.pageUrl}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">On file</h3>
        {detail.company ? (
          <Link href={companyPath(detail.company.companySeq)} className="block text-brand hover:underline">
            {detail.contact ? `${detail.contact.name} · ` : ""}
            {detail.company.name}
          </Link>
        ) : (
          <p className="text-xs text-muted">Not linked to a customer yet. It links itself when their email or number is on file.</p>
        )}
        {detail.lead && (
          <Link href={`/leads/${detail.lead.reference}`} className="block text-brand hover:underline">
            Lead {detail.lead.reference}
          </Link>
        )}
        {detail.ticket && (
          <Link href={ticketPath(detail.ticket.ticketSeq)} className="block text-brand hover:underline">
            Its ticket
          </Link>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          {canMakeLead && !detail.lead && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(async () => inboxMakeLead(detail.id), undefined, "Lead made.")}>
              <UserPlus aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Make a lead
            </Button>
          )}
          {canMakeTicket && !detail.ticket && ticketTitle === null && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setTicketTitle(detail.messages.find((m) => m.author === "CUSTOMER")?.body.slice(0, 80) ?? "")}>
              <Ticket aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Turn into ticket
            </Button>
          )}
        </div>
        {ticketTitle !== null && (
          <form
            className="space-y-2 rounded-base border border-line p-2"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => inboxMakeTicket(detail.id, ticketTitle), () => setTicketTitle(null), "Ticket made.");
            }}
          >
            <Label htmlFor="inbox-ticket-title">Ticket title</Label>
            <Input id="inbox-ticket-title" value={ticketTitle} maxLength={200} onChange={(e) => setTicketTitle(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" type="submit" disabled={pending || ticketTitle.trim().length < 2}>
                Make the ticket
              </Button>
              <Button size="sm" type="button" variant="ghost" onClick={() => setTicketTitle(null)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </div>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Who has it</h3>
        <Select aria-label="Who has it" value={assignedId} disabled={pending} onChange={(e) => act(() => inboxAssign(detail.id, e.target.value || null))}>
          <option value="">Nobody — in the queue</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === meId ? `${p.name} (you)` : p.name}
            </option>
          ))}
        </Select>
        {assignedId !== meId && (
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => inboxAssign(detail.id, meId))}>
            Take it
          </Button>
        )}
      </div>

      <div className="space-y-1 text-xs text-muted">
        <p>Started {time(detail.createdAt)}</p>
        {detail.firstResponseAt && <p>First reply {time(detail.firstResponseAt)}</p>}
        <p>
          {detail.channel.kind === "WHATSAPP" ? `WhatsApp${detail.channel.displayPhone ? ` ${detail.channel.displayPhone}` : ""}` : "Website chat"} · {detail.channel.shared ? "shared" : "a rep's own number"}
        </p>
      </div>
    </aside>
  );

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] min-h-[28rem] overflow-hidden rounded-xl border border-line bg-surface">
      {list}
      {thread}
      {details}
    </div>
  );
}
