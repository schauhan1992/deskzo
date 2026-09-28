"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, Plus, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { useModalA11y } from "@/components/ui/use-modal-a11y";
import { LAYER_MODAL } from "@/components/ui/layers";
import { Button } from "@/components/ui/button";
import { ChatText } from "@/components/copilot/chat-text";
import { ActivityLine, ProposalCard, ReportCard } from "@/components/copilot/chat-blocks";
import {
  deleteCopilotConversation,
  getCopilotConversation,
  listCopilotConversations,
  type ChatItem,
  type ChatSegment,
  type CopilotAvailability,
} from "@/actions/copilot";
import type { ChatEvent, ProposalBlock } from "@/lib/copilot/types";
import { COPILOT_OPEN_EVENT } from "@/lib/side-rail";

const STARTERS = [
  "Which subscriptions come up for renewal in the next 30 days?",
  "Show this month's bookings by salesperson",
  "Which of my leads are hot right now?",
  "Remind me to call the top renewal customer tomorrow",
];

/**
 * The copilot: a button in the header and the chat it opens. See src/lib/copilot/ for what it can
 * do and why it can never see more than the person using it.
 */
export function CopilotButton({ availability }: { availability: CopilotAvailability }) {
  const [open, setOpen] = useState(false);
  // The rail has a copilot button too. One drawer, opened from either place, rather than two
  // copies of the chat that would each keep their own half of a conversation.
  useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener(COPILOT_OPEN_EVENT, openIt);
    return () => window.removeEventListener(COPILOT_OPEN_EVENT, openIt);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-base border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-text hover:bg-surface-sunken"
        title="Ask the AI copilot"
      >
        <Sparkles className="h-4 w-4 text-brand" aria-hidden="true" />
        <span className="hidden sm:inline">Copilot</span>
      </button>
      {open && <CopilotPanel availability={availability} onClose={() => setOpen(false)} />}
    </>
  );
}

function CopilotPanel({ availability, onClose }: { availability: CopilotAvailability; onClose: () => void }) {
  const { titleId, containerRef } = useModalA11y(true, onClose);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [history, setHistory] = useState<{ id: string; title: string }[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState({ used: availability.usedToday, limit: availability.limit });
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  async function openHistory() {
    setShowHistory((v) => !v);
    setHistory(await listCopilotConversations());
  }

  async function load(id: string) {
    const c = await getCopilotConversation(id);
    setShowHistory(false);
    if (!c) return;
    setConversationId(c.id);
    setItems(c.items);
  }

  function startNew() {
    abortRef.current?.abort();
    setConversationId(null);
    setItems([]);
    setShowHistory(false);
  }

  async function remove(id: string) {
    await deleteCopilotConversation(id);
    setHistory((h) => h?.filter((c) => c.id !== id) ?? null);
    if (id === conversationId) startNew();
  }

  /** Applies one streamed event to the reply being written — always the last item. */
  function apply(event: ChatEvent, fresh: { value: boolean }) {
    if (event.type === "conversation") {
      setConversationId(event.id);
      return;
    }
    if (event.type === "done") {
      setUsage({ used: event.usedToday, limit: event.limit });
      return;
    }
    if (event.type === "step") {
      fresh.value = true;
      return;
    }
    if (event.type === "error") {
      setItems((prev) => [...prev, { role: "note", text: event.message }]);
      return;
    }
    // Decided here, not inside the updater: React may run an updater twice, and it has to come out
    // the same both times.
    const startSegment = fresh.value;
    fresh.value = event.type === "block";
    setItems((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      const reply: Extract<ChatItem, { role: "assistant" }> = last?.role === "assistant" ? { ...last, segments: [...last.segments] } : { role: "assistant", segments: [] };
      if (last?.role === "assistant") next[next.length - 1] = reply;
      else next.push(reply);
      if (event.type === "text") {
        const tail = reply.segments.at(-1);
        if (tail?.kind === "text" && !startSegment) reply.segments[reply.segments.length - 1] = { kind: "text", text: tail.text + event.delta };
        else reply.segments.push({ kind: "text", text: event.delta });
      } else {
        reply.segments.push({ kind: "block", block: event.block });
      }
      return next;
    });
  }

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setItems((prev) => [...prev, { role: "user", text: message }]);
    const controller = new AbortController();
    abortRef.current = controller;
    const fresh = { value: true };
    try {
      const response = await fetch("/api/copilot/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        apply({ type: "error", message: body?.error ?? "The copilot couldn't be reached." }, fresh);
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line.trim()) apply(JSON.parse(line) as ChatEvent, fresh);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) apply({ type: "error", message: "The connection to the copilot dropped." }, fresh);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  function updateProposal(next: ProposalBlock) {
    setItems((prev) =>
      prev.map((item) =>
        item.role !== "assistant"
          ? item
          : {
              ...item,
              segments: item.segments.map((s): ChatSegment => (s.kind === "block" && s.block.type === "proposal" && s.block.id === next.id ? { kind: "block", block: next } : s)),
            },
      ),
    );
  }

  const percent = Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100));

  return createPortal(
    <div className={`fixed inset-0 ${LAYER_MODAL}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute right-0 top-0 flex h-full w-full max-w-[460px] flex-col bg-surface shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <Sparkles className="h-4 w-4 text-brand" aria-hidden="true" />
          <h2 id={titleId} className="text-sm font-semibold text-text">
            Copilot
          </h2>
          <span className="truncate text-[11px] text-subtle">{availability.model}</span>
          <div className="ml-auto flex items-center gap-1">
            <button type="button" onClick={openHistory} title="Earlier chats" className="rounded p-1.5 text-subtle hover:bg-surface-sunken hover:text-text">
              <History className="h-4 w-4" />
            </button>
            <button type="button" onClick={startNew} title="New chat" className="rounded p-1.5 text-subtle hover:bg-surface-sunken hover:text-text">
              <Plus className="h-4 w-4" />
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1.5 text-subtle hover:bg-surface-sunken hover:text-text">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {showHistory && (
          <div className="max-h-64 overflow-y-auto border-b border-line bg-surface-sunken px-2 py-2">
            {history === null ? (
              <p className="px-2 py-1 text-[12px] text-subtle">Loading…</p>
            ) : history.length === 0 ? (
              <p className="px-2 py-1 text-[12px] text-subtle">No earlier chats.</p>
            ) : (
              history.map((c) => (
                <div key={c.id} className="group flex items-center gap-1">
                  <button type="button" onClick={() => load(c.id)} className="min-w-0 flex-1 truncate rounded px-2 py-1 text-left text-[13px] text-text hover:bg-surface">
                    {c.title}
                  </button>
                  <button type="button" onClick={() => remove(c.id)} title="Delete this chat" className="rounded p-1 text-subtle opacity-0 hover:text-danger group-hover:opacity-100">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {!availability.available ? (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-[13px] text-warning">{availability.reason}</p>
          ) : items.length === 0 ? (
            <div className="space-y-3">
              <p className="text-[13px] text-muted">
                Ask about your customers, pipeline, renewals, orders or tickets, get a report, or have a task or note drafted. It sees only what you can see in the app.
              </p>
              <div className="space-y-1.5">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => send(s)} className="block w-full rounded-base border border-line px-3 py-2 text-left text-[13px] text-text hover:bg-surface-sunken">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            items.map((item, i) =>
              item.role === "user" ? (
                <div key={i} className="ml-8 whitespace-pre-wrap rounded-base bg-brand px-3 py-2 text-[13px] text-brand-contrast">
                  {item.text}
                </div>
              ) : item.role === "note" ? (
                <p key={i} className="text-center text-[11px] text-subtle">
                  {item.text}
                </p>
              ) : (
                <div key={i} className="mr-4 space-y-2">
                  {item.segments.map((s, j) =>
                    s.kind === "text" ? (
                      <ChatText key={j} text={s.text} onNavigate={onClose} />
                    ) : s.block.type === "activity" ? (
                      <ActivityLine key={j} block={s.block} />
                    ) : s.block.type === "report" ? (
                      <ReportCard key={j} block={s.block} />
                    ) : (
                      <ProposalCard key={j} block={s.block} onChange={updateProposal} />
                    ),
                  )}
                </div>
              ),
            )
          )}
          {busy && <p className="text-[11px] text-subtle">Working…</p>}
        </div>

        <form
          className="space-y-1.5 border-t border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-label="Message the copilot"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={2}
              maxLength={4000}
              disabled={!availability.available}
              placeholder="Ask anything about your data…"
              className="min-h-[2.5rem] flex-1 resize-none rounded-base border border-line-strong bg-surface px-3 py-2 text-[13px] text-text outline-none focus:border-brand"
            />
            {busy ? (
              <Button type="button" variant="secondary" size="icon" onClick={() => abortRef.current?.abort()} title="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim() || !availability.available} title="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2 text-[10px] text-subtle">
            <div className="h-1 flex-1 overflow-hidden rounded bg-surface-sunken" title={`${usage.used.toLocaleString("en-IN")} of ${usage.limit.toLocaleString("en-IN")} tokens today`}>
              <div className={`h-full ${percent > 85 ? "bg-danger" : "bg-brand"}`} style={{ width: `${percent}%` }} />
            </div>
            <span>{percent}% of today&apos;s allowance · {availability.provider}</span>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
