"use client";

import { useMemo, useState, useTransition } from "react";
import { Check, Search, ShieldCheck } from "lucide-react";
import {
  addGroupMembers,
  createGroupChat,
  leaveGroupChat,
  removeGroupMember,
  renameGroupChat,
  setGroupAdmin,
  startDirectChat,
  type ChatBootstrap,
} from "@/actions/chat";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { MAX_GROUP_NAME } from "@/lib/chat/rules";
import type { ChatMemberView, ChatPerson, ChatSummary } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

/** Colleagues to pick from, searched by name or department. One click picks one; `multiple` ticks several. */
function PeoplePicker({
  people,
  selected,
  onPick,
  multiple = false,
}: {
  people: ChatPerson[];
  selected?: ReadonlySet<string>;
  onPick: (id: string) => void;
  multiple?: boolean;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = people.filter((p) => p.active && (!q || p.name.toLowerCase().includes(q) || (p.department ?? "").toLowerCase().includes(q)));
  return (
    <div>
      <label className="relative block">
        <span className="sr-only">Search colleagues</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or department" className="pl-8" autoFocus />
      </label>
      <ul role="list" className="mt-2 max-h-72 overflow-y-auto rounded-base border border-line">
        {shown.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nobody by that name.</li>}
        {shown.map((p) => {
          const on = selected?.has(p.id) ?? false;
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                aria-pressed={multiple ? on : undefined}
                className={cn("flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-sunken", on && "bg-brand-subtle/50")}
              >
                <Avatar user={{ id: p.id, name: p.name, photoUpdatedAt: p.photoUpdatedAt }} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-text">{p.name}</span>
                  {p.department && <span className="block truncate text-[11px] text-subtle">{p.department}</span>}
                </span>
                {multiple && (
                  <span className={cn("grid h-4 w-4 shrink-0 place-items-center rounded border", on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong")}>
                    {on && <Check className="h-3 w-3" />}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function NewChatDialog({ open, onClose, people, onStarted }: { open: boolean; onClose: () => void; people: ChatPerson[]; onStarted: (chatId: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onClose={onClose} title="New chat">
      <PeoplePicker
        people={people}
        onPick={(id) =>
          start(async () => {
            setError(null);
            const res = await startDirectChat(id);
            if (!res.ok) return setError(res.error);
            onClose();
            onStarted(res.data.chatId);
          })
        }
      />
      {pending && <p className="mt-2 text-xs text-muted">Opening…</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

/** Quick ways to fill a group: everybody who reports to me, or a whole department. */
function QuickAdd({ boot, onAdd }: { boot: ChatBootstrap; onAdd: (ids: string[]) => void }) {
  if (boot.myTeam.length === 0 && boot.departments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {boot.myTeam.length > 0 && (
        <Button type="button" variant="secondary" size="sm" onClick={() => onAdd(boot.myTeam)}>
          Add my team ({boot.myTeam.length})
        </Button>
      )}
      {boot.departments.some((d) => d.memberIds.length > 0) && (
        <Select
          aria-label="Add a whole department"
          value=""
          onChange={(e) => {
            const dept = boot.departments.find((d) => d.id === e.target.value);
            if (dept) onAdd(dept.memberIds);
          }}
          className="h-8 w-auto text-[13px]"
        >
          <option value="">Add a department…</option>
          {boot.departments
            .filter((d) => d.memberIds.length > 0)
            .map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.memberIds.length})
              </option>
            ))}
        </Select>
      )}
    </div>
  );
}

export function NewGroupDialog({ open, onClose, boot, onStarted }: { open: boolean; onClose: () => void; boot: ChatBootstrap; onStarted: (chatId: string) => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const close = () => {
    setName("");
    setPicked(new Set());
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="New group">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            setError(null);
            const res = await createGroupChat({ name, memberIds: [...picked] });
            if (!res.ok) return setError(res.error);
            close();
            onStarted(res.data.chatId);
          });
        }}
        className="space-y-3"
      >
        <div className="space-y-1.5">
          <Label htmlFor="chat-group-name">Group name</Label>
          <Input id="chat-group-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_GROUP_NAME} placeholder="e.g. Sales — North" required />
        </div>
        <QuickAdd boot={boot} onAdd={(ids) => setPicked((s) => new Set([...s, ...ids.filter((id) => boot.people.some((p) => p.id === id && p.active))]))} />
        <PeoplePicker people={boot.people} selected={picked} onPick={toggle} multiple />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted">{picked.size} picked, and you</span>
          <Button type="submit" disabled={pending || !name.trim() || picked.size === 0}>
            {pending ? "Creating…" : "Create group"}
          </Button>
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
      </form>
    </Dialog>
  );
}

/** A group's name and people: admins rename it, add and remove people and make others admins; anyone can leave. */
export function GroupInfoDialog({
  open,
  onClose,
  boot,
  chat,
  members,
}: {
  open: boolean;
  onClose: () => void;
  boot: ChatBootstrap;
  chat: ChatSummary;
  members: ChatMemberView[];
}) {
  const [name, setName] = useState(chat.title);
  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const current = useMemo(() => members.filter((m) => !m.leftAt), [members]);
  const iAmAdmin = !chat.left && current.some((m) => m.userId === boot.me.id && m.isAdmin);
  const addable = boot.people.filter((p) => !current.some((m) => m.userId === p.id));

  const run = (work: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const res = await work();
      if (!res.ok) return setError(res.error ?? "That didn't work.");
      after?.();
    });

  return (
    <Dialog open={open} onClose={onClose} title="Group info">
      <div className="space-y-4">
        {iAmAdmin ? (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => renameGroupChat(chat.id, name));
            }}
          >
            <div className="min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="chat-rename">Group name</Label>
              <Input id="chat-rename" value={name} onChange={(e) => setName(e.target.value)} maxLength={MAX_GROUP_NAME} />
            </div>
            <Button type="submit" variant="secondary" disabled={pending || !name.trim() || name.trim() === chat.title}>
              Rename
            </Button>
          </form>
        ) : (
          <p className="text-sm font-medium text-text">{chat.title}</p>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-subtle">{current.length} people</span>
            {iAmAdmin && !adding && addable.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(true)}>
                Add people
              </Button>
            )}
          </div>
          {adding ? (
            <div className="space-y-2">
              <QuickAdd boot={boot} onAdd={(ids) => setPicked((s) => new Set([...s, ...ids.filter((id) => addable.some((p) => p.id === id && p.active))]))} />
              <PeoplePicker
                people={addable}
                selected={picked}
                multiple
                onPick={(id) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={() => (setAdding(false), setPicked(new Set()))}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={pending || picked.size === 0}
                  onClick={() => run(() => addGroupMembers(chat.id, [...picked]), () => (setAdding(false), setPicked(new Set())))}
                >
                  Add {picked.size || ""}
                </Button>
              </div>
            </div>
          ) : (
            <ul role="list" className="max-h-72 divide-y divide-line overflow-y-auto rounded-base border border-line">
              {current.map((m) => (
                <li key={m.userId} className="flex items-center gap-2.5 px-3 py-2">
                  <Avatar user={{ id: m.userId, name: m.name, photoUpdatedAt: m.photoUpdatedAt }} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                    {m.userId === boot.me.id ? "You" : m.name}
                  </span>
                  {m.isAdmin && (
                    <span className="flex items-center gap-1 text-[11px] text-brand">
                      <ShieldCheck className="h-3 w-3" /> Admin
                    </span>
                  )}
                  {iAmAdmin && m.userId !== boot.me.id && (
                    <span className="flex gap-1">
                      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setGroupAdmin(chat.id, m.userId, !m.isAdmin))}>
                        {m.isAdmin ? "Remove admin" : "Make admin"}
                      </Button>
                      <Button type="button" variant="ghost" size="sm" disabled={pending} className="text-danger" onClick={() => run(() => removeGroupMember(chat.id, m.userId))}>
                        Remove
                      </Button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        {!chat.left && (
          <div className="flex justify-end border-t border-line pt-3">
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() => {
                if (window.confirm(`Leave "${chat.title}"? You'll keep what was said until now.`)) run(() => leaveGroupChat(chat.id), onClose);
              }}
            >
              Leave group
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
