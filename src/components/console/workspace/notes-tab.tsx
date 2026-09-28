"use client";

import { useId, useState, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { LoaderCircle, NotebookPen, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { consoleAddNote, consoleDeleteNote, consoleEditNote, consolePinNote, consoleSetTags } from "@/actions/platform/console-workspace";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNotice, ActionNoticeRegion } from "@/components/ui/action-notice";
import { Checkbox } from "@/components/ui/bulk-select";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { dayMonth, plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { NoteView } from "@/lib/platform/workspace-data";
import { cn } from "@/lib/utils";

/**
 * Workspace 360 › Notes: what staff want the next person looking at this workspace to know, and its
 * tags. For staff only — the workspace never sees either.
 *
 * Plain text, always: a note's body is a text node (`whitespace-pre-wrap`), never HTML, so whatever
 * was pasted into it shows as written. Everybody who changes anything (owners, admins, support,
 * billing) adds notes, pins them (five at most) and edits tags; a note's author, or an owner or
 * admin, edits and deletes it. READONLY reads.
 */

const NOTE_MAX = 4000;
/** As the actions enforce (src/lib/platform/workspace-data.ts PIN_CAP, consoleSetTags). */
const PIN_CAP = 5;
const TAG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TAGS_MAX = 10;

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

/** Ctrl/⌘+Enter sends; Enter alone is a new line. */
function submitOnModEnter(e: KeyboardEvent<HTMLTextAreaElement>) {
  if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  e.currentTarget.form?.requestSubmit();
}

export function NotesTab({ tenantId, notes, tags, caps }: { tenantId: string; notes: NoteView[]; tags: string[]; caps: Caps }) {
  const pinnedCount = notes.filter((n) => n.pinned).length;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 space-y-6 lg:col-span-2">
        {caps.write && <AddNote tenantId={tenantId} pinFull={pinnedCount >= PIN_CAP} />}
        <Panel
          title="Notes"
          description="For staff only — the workspace never sees them."
          actions={notes.length > 0 ? <span className="text-xs text-muted tabular-nums">{`${plural(notes.length, "note")} · ${INTEGER.format(pinnedCount)} pinned`}</span> : undefined}
          padded={false}
        >
          {notes.length === 0 ? (
            <EmptyState
              icon={<NotebookPen className="h-5 w-5" />}
              title="No notes yet"
              body={caps.write ? "Write down what the next person looking at this workspace should know." : "Staff have not written anything about this workspace."}
            />
          ) : (
            <ul className="divide-y divide-line">
              {notes.map((note) => (
                <NoteItem key={note.id} note={note} caps={caps} />
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <div className="min-w-0 space-y-6">
        <TagsPanel tenantId={tenantId} tags={tags} caps={caps} />
      </div>
    </div>
  );
}

// ─── Adding ──────────────────────────────────────────────────────────────────────────────────────

function AddNote({ tenantId, pinFull }: { tenantId: string; pinFull: boolean }) {
  const [body, setBody] = useState("");
  const [pin, setPin] = useState(false);
  const { pending, error, run, reset } = useConsoleAction<{ id: string }>();
  const bodyId = useId();
  const hintId = useId();
  const text = body.trim();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!text || pending) return;
    run(() => consoleAddNote(tenantId, body, pin && !pinFull), {
      success: "Note added.",
      onDone: () => {
        setBody("");
        setPin(false);
      },
    });
  }

  return (
    <Panel title="Add a note">
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={bodyId}>Note</Label>
          <Textarea
            id={bodyId}
            value={body}
            onChange={(e) => {
              if (error) reset();
              setBody(e.target.value);
            }}
            onKeyDown={submitOnModEnter}
            maxLength={NOTE_MAX}
            rows={3}
            placeholder="e.g. Pays by bank transfer every quarter — talk to Asha before chasing an invoice."
            aria-describedby={hintId}
            readOnly={pending}
          />
          <p id={hintId} className="text-xs text-subtle tabular-nums">{`Plain text · ${INTEGER.format(body.length)} / ${INTEGER.format(NOTE_MAX)}`}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
              <Checkbox checked={pin && !pinFull} onChange={(e) => setPin(e.target.checked)} disabled={pinFull || pending} />
              Pin it
            </label>
            {pinFull && <span className="text-xs text-muted">{`${PIN_CAP} notes are pinned already — unpin one to pin another.`}</span>}
          </div>
          <Button type="submit" size="sm" disabled={!text} aria-disabled={pending || undefined} aria-busy={pending || undefined} className={pending ? "cursor-wait opacity-70" : undefined}>
            {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Add note
          </Button>
        </div>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </form>
    </Panel>
  );
}

// ─── One note ────────────────────────────────────────────────────────────────────────────────────

function NoteItem({ note, caps }: { note: NoteView; caps: Caps }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [deleting, setDeleting] = useState(false);
  const edit = useConsoleAction<null>();
  const pin = useConsoleAction<null>();
  const remove = useConsoleAction<null>();
  const editId = useId();

  const canChange = caps.write && (note.mine || caps.manage);
  const whose = note.mine ? "your" : `${note.author}'s`;
  const which = `${whose} note from ${dayMonth(note.createdAt)}`;
  const changed = draft.trim() !== "" && draft.trim() !== note.body.trim();

  function startEdit() {
    edit.reset();
    setDraft(note.body);
    setEditing(true);
  }

  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!changed || edit.pending) return;
    edit.run(() => consoleEditNote(note.id, draft), { success: "Note saved.", onDone: () => setEditing(false) });
  }

  function togglePin() {
    if (pin.pending) return;
    pin.run(() => consolePinNote(note.id, !note.pinned), { success: note.pinned ? "Note unpinned." : "Note pinned." });
  }

  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
          <span className="font-medium text-text">{note.mine ? `${note.author} (you)` : note.author}</span>
          <span aria-hidden="true">·</span>
          <RelativeTime at={note.createdAt} />
          {note.editedBy && (
            <>
              <span aria-hidden="true">·</span>
              <span>{note.editedBy === note.author ? "edited" : `edited by ${note.editedBy}`}</span>
            </>
          )}
          {note.pinned && (
            <StatusPill tone="brand" icon={<Pin className="h-3 w-3" />} className="ml-1">
              Pinned
            </StatusPill>
          )}
        </p>
        {caps.write && (
          <div className="-mt-1 -mr-1 flex shrink-0 items-center gap-0.5">
            <IconButton icon={note.pinned ? PinOff : Pin} label={`${note.pinned ? "Unpin" : "Pin"} ${which}`} onClick={togglePin} aria-busy={pin.pending || undefined} />
            {canChange && !editing && <IconButton icon={Pencil} label={`Edit ${which}`} onClick={startEdit} />}
            {canChange && (
              <IconButton
                icon={Trash2}
                tone="danger"
                label={`Delete ${which}`}
                onClick={() => {
                  remove.reset();
                  setDeleting(true);
                }}
              />
            )}
          </div>
        )}
      </div>

      {editing ? (
        <form onSubmit={save} className="mt-2 space-y-2">
          <Label htmlFor={editId} className="sr-only">
            Note
          </Label>
          <Textarea id={editId} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={submitOnModEnter} maxLength={NOTE_MAX} rows={4} readOnly={edit.pending} />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={edit.pending}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!changed} aria-disabled={edit.pending || undefined} aria-busy={edit.pending || undefined}>
              {edit.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Save note
            </Button>
          </div>
          {edit.error && <ActionNotice tone="error">{edit.error}</ActionNotice>}
        </form>
      ) : (
        <p className="mt-1.5 text-sm whitespace-pre-wrap break-words text-text">{note.body}</p>
      )}

      {pin.error && <ActionNotice tone="error" className="mt-2">{pin.error}</ActionNotice>}

      {canChange && (
        <ConfirmDialog
          open={deleting}
          onClose={() => {
            setDeleting(false);
            remove.reset();
          }}
          title="Delete note"
          confirmLabel="Delete note"
          tone="danger"
          pending={remove.pending}
          error={remove.error}
          onConfirm={() => remove.run(() => consoleDeleteNote(note.id), { success: "Note deleted.", onDone: () => setDeleting(false) })}
        >
          <p>It disappears from this page. The record that it existed, and who removed it, is kept.</p>
          <p className="line-clamp-4 rounded-lg border border-line bg-surface-sunken px-3 py-2 whitespace-pre-wrap break-words text-muted">{note.body}</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

function TagsPanel({ tenantId, tags, caps }: { tenantId: string; tags: string[]; caps: Caps }) {
  const [list, setList] = useState(tags);
  const [seenKey, setSeenKey] = useState(tags.join(","));
  const [input, setInput] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const { pending, error, run, reset } = useConsoleAction<{ tags: string[] }>();
  const inputId = useId();
  const hintId = useId();

  // The page brought the saved list (after a save, or a change made elsewhere): show that.
  const key = tags.join(",");
  if (key !== seenKey) {
    setSeenKey(key);
    setList(tags);
  }

  function save(next: string[]) {
    reset();
    run(() => consoleSetTags(tenantId, next), { success: "Tags saved.", onDone: (data) => setList(data.tags) });
  }

  function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const tag = input.trim().toLowerCase();
    if (!tag) return;
    if (!TAG.test(tag)) {
      setHint("A tag is lower-case letters, digits and dashes — up to 24, starting with a letter or digit.");
      return;
    }
    setHint(null);
    if (list.includes(tag)) {
      setInput("");
      return;
    }
    if (list.length >= TAGS_MAX) {
      setHint(`A workspace has at most ${TAGS_MAX} tags — remove one first.`);
      return;
    }
    setInput("");
    save([...list, tag]);
  }

  return (
    <Panel title="Tags" description="Short labels for finding workspaces — the list filters by them.">
      <div className="space-y-3">
        {list.length === 0 ? (
          <p className="text-xs text-subtle">No tags yet.</p>
        ) : (
          <ul aria-label="Tags" className={cn("flex flex-wrap gap-1.5", pending && "opacity-60")}>
            {list.map((tag) => (
              <li key={tag} className="inline-flex h-6 max-w-full items-center gap-0.5 rounded-full border border-line bg-surface-sunken pr-0.5 pl-2 text-xs text-muted">
                <Link href={`/workspaces?tag=${encodeURIComponent(tag)}`} className="truncate rounded-base hover:text-text" title={`Workspaces tagged ${tag}`}>
                  {tag}
                </Link>
                {caps.write && (
                  <button
                    type="button"
                    aria-label={`Remove the tag ${tag}`}
                    title={`Remove the tag ${tag}`}
                    onClick={() => !pending && save(list.filter((t) => t !== tag))}
                    className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-subtle hover:bg-surface hover:text-danger"
                  >
                    <X aria-hidden="true" className="h-3 w-3" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {caps.write && (
          <form onSubmit={add} className="space-y-1.5">
            <Label htmlFor={inputId}>Add a tag</Label>
            <div className="flex gap-2">
              <Input
                id={inputId}
                value={input}
                onChange={(e) => {
                  setHint(null);
                  setInput(e.target.value);
                }}
                maxLength={24}
                placeholder="e.g. pilot"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby={hintId}
                aria-invalid={hint ? true : undefined}
                className="h-8 lowercase"
              />
              <Button type="submit" size="sm" variant="secondary" disabled={!input.trim() || list.length >= TAGS_MAX} aria-busy={pending || undefined}>
                {pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
                Add
              </Button>
            </div>
            <p id={hintId} className={cn("text-xs", hint ? "text-danger" : "text-subtle")}>
              {hint ?? `${INTEGER.format(list.length)} of ${TAGS_MAX} · lower-case letters, digits and dashes`}
            </p>
            <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          </form>
        )}
      </div>
    </Panel>
  );
}
