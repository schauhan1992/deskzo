"use client";

import { useEffect, useState, useTransition } from "react";
import { Download, Search } from "lucide-react";
import { findChatsToExport, saveChatSettings, type ExportableChat } from "@/actions/chat-admin";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { RETENTION_CHOICES } from "@/lib/chat/rules";

/** The workspace's chat rules: view-only files and how long messages are kept. */
export function ChatSettingsForm({ initial }: { initial: { attachmentsViewOnly: boolean; retentionDays: number | null } }) {
  const [viewOnly, setViewOnly] = useState(initial.attachmentsViewOnly);
  const [retention, setRetention] = useState<number | null>(initial.retentionDays);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const shortening = retention !== null && (initial.retentionDays === null || retention < initial.retentionDays);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (shortening && !window.confirm("Messages older than this will be deleted for everybody tonight, files and all, and can't be brought back. Go ahead?")) return;
        start(async () => {
          const res = await saveChatSettings({ attachmentsViewOnly: viewOnly, retentionDays: retention });
          setMessage(res.ok ? { tone: "ok", text: "Saved." } : { tone: "error", text: res.error });
        });
      }}
    >
      <label className="flex items-start gap-2.5">
        <input type="checkbox" className="mt-0.5 h-4 w-4" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} />
        <span>
          <span className="block text-sm text-text">Files are view-only</span>
          <span className="block text-xs text-muted">
            Pictures, PDFs and text open in the browser and there is no download button; other files can&apos;t be opened at all. A deterrent, like the
            copy and screenshot rules — not a guarantee.
          </span>
        </span>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor="chat-retention">Keep messages</Label>
        <Select id="chat-retention" value={retention === null ? "" : String(retention)} onChange={(e) => setRetention(e.target.value ? Number(e.target.value) : null)} className="max-w-sm">
          {RETENTION_CHOICES.map((c) => (
            <option key={c.label} value={c.days === null ? "" : String(c.days)}>
              {c.label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">Older messages are deleted each night, with their files.</p>
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        {message && <span className={message.tone === "ok" ? "text-sm text-success" : "text-sm text-danger"}>{message.text}</span>}
      </div>
    </form>
  );
}

/** The super admin's search for one chat to export: names and people only. */
export function ChatExportPanel() {
  const clock = useClock();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; chats: ExportableChat[] } | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    const timer = setTimeout(() => void findChatsToExport(q).then((chats) => setResult({ query: q, chats })).catch(() => setResult({ query: q, chats: [] })), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const found = result && result.query === query.trim() && query.trim().length >= 2 ? result.chats : null;

  return (
    <div className="space-y-3">
      <label className="relative block max-w-sm">
        <span className="sr-only">Find a chat</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="A person's or a group's name" className="pl-8" />
      </label>
      {found && found.length === 0 && <p className="text-sm text-muted">No chats with messages match that.</p>}
      {found && found.length > 0 && (
        <ul role="list" className="divide-y divide-line rounded-base border border-line">
          {found.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">{c.title}</span>
                <span className="block truncate text-xs text-muted">
                  {c.kind === "GROUP" ? `${c.members.length} people · ` : ""}
                  {c.messageCount} message{c.messageCount === 1 ? "" : "s"}
                  {c.lastMessageAt ? ` · last ${clock.date(c.lastMessageAt)}` : ""}
                </span>
              </span>
              <a
                href={`/api/chat/export/${c.id}`}
                onClick={(e) => {
                  if (!window.confirm(`Export "${c.title}"? This is recorded in the audit trail and the activity log.`)) e.preventDefault();
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-base border border-line-strong px-3 text-[13px] text-text hover:bg-surface-sunken"
              >
                <Download className="h-3.5 w-3.5" /> Export
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
