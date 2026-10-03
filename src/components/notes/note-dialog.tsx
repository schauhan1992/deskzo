"use client";

import { useState } from "react";
import { Check, Globe, Lock, Users } from "lucide-react";
import type { NoteListItem } from "@/actions/note";
import { createNote, updateNote } from "@/actions/note";
import {
  NOTE_BODY_MAX,
  NOTE_TITLE_MAX,
  noteColorValues,
  type NoteColor,
  type NoteVisibility,
} from "@/lib/validation/note";
import { noteColorClasses, noteColorLabel } from "@/components/notes/note-card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { cn } from "@/lib/utils";
import type { Clock } from "@/lib/time/zone";

/*
 * The reminder field holds a time on the workspace's clock — `clock.input` fills it, and it is sent as
 * typed for `createNote`/`updateNote` to read on the same clock. It used the browser's offset both
 * ways, so somebody whose computer was in another zone set reminders hours away from what they typed.
 */

/**
 * The three answers people actually give, on the workspace's clock.
 *
 * Evaluated on click rather than when the module loads, so "tomorrow" stays tomorrow in a tab that
 * has been open overnight.
 */
const QUICK_REMINDERS: { label: string; at: (clock: Clock) => Date }[] = [
  {
    label: "This evening",
    at: (clock) => {
      const now = new Date();
      const { year, month, day } = clock.parts(now);
      const evening = clock.at(year, month, day, 18);
      // Already past six: the useful reading of "this evening" is then tomorrow evening.
      return evening.getTime() <= now.getTime() ? clock.at(year, month, day + 1, 18) : evening;
    },
  },
  {
    label: "Tomorrow 9am",
    at: (clock) => {
      const { year, month, day } = clock.parts(new Date());
      return clock.at(year, month, day + 1, 9);
    },
  },
  {
    label: "Next Monday",
    at: (clock) => {
      const { year, month, day, weekday } = clock.parts(new Date());
      return clock.at(year, month, day + ((8 - weekday) % 7 || 7), 9);
    },
  },
];

/**
 * The fields the dialog actually edits, rather than the whole row.
 *
 * Deliberately a subset of `NoteListItem` so a caller holding a full note can pass it unchanged,
 * while a caller that only has these five fields is not forced to invent a `noteSeq` and an owner
 * to satisfy the type.
 */
export type EditableNote = Pick<NoteListItem, "id" | "title" | "body" | "color" | "visibility" | "pinned" | "remindAt">;

/** What a new note can be pre-stuck to. Fixed at creation, which is why there is no edit equivalent. */
export type NoteDefaults = { companyId?: string; leadId?: string; ticketId?: string };

const VISIBILITY_OPTIONS: { value: NoteVisibility; label: string; hint: string; icon: typeof Lock }[] = [
  { value: "PRIVATE", label: "Just me", hint: "Nobody else can read this, including admins.", icon: Lock },
  { value: "TEAM", label: "My team", hint: "Everyone in your department can read it.", icon: Users },
  { value: "EVERYONE", label: "Everyone", hint: "This goes on the board of every signed-in person in the company.", icon: Globe },
];

/**
 * Write or edit a note.
 *
 * Controlled by the caller rather than owning its own trigger, because the same dialog is opened
 * from the notes board, from the create menu in the top bar, and from a company or ticket page that
 * wants the note pre-attached to the record being looked at.
 *
 * Every field the note has is submitted together, always. `updateNote` replaces the row rather than
 * patching it — omitting `color` or `pinned` does not leave them alone, it resets them to the zod
 * defaults — so there is one piece of state per field here and one submit that sends all of them.
 */
export function NoteDialog({
  open,
  onClose,
  note,
  defaults,
  canBroadcast = false,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  note?: EditableNote | null;
  defaults?: NoteDefaults;
  canBroadcast?: boolean;
  onSaved?: () => void;
}) {
  const clock = useClock();
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.body ?? "");
  const [color, setColor] = useState<NoteColor>(note?.color ?? "YELLOW");
  const [visibility, setVisibility] = useState<NoteVisibility>(note?.visibility ?? "PRIVATE");
  const [pinned, setPinned] = useState(note?.pinned ?? false);
  const [remindAt, setRemindAt] = useState(clock.input(note?.remindAt));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Refill the fields whenever the dialog is opened, or opened onto a different note. The component
  // stays mounted between opens — `Dialog` is what renders nothing while closed — so without this
  // the second note you edit would open showing the first one's text. Adjusting state during render
  // is React's own answer to deriving state from props; an effect here would paint the stale values
  // for a frame first.
  const formKey = `${open ? "open" : "shut"}:${note?.id ?? "new"}`;
  const [syncedKey, setSyncedKey] = useState(formKey);
  if (formKey !== syncedKey) {
    setSyncedKey(formKey);
    setTitle(note?.title ?? "");
    setBody(note?.body ?? "");
    setColor(note?.color ?? "YELLOW");
    setVisibility(note?.visibility ?? "PRIVATE");
    setPinned(note?.pinned ?? false);
    setRemindAt(clock.input(note?.remindAt));
    setError(null);
  }

  // "Everyone" is offered only to people who hold `notes.broadcast`, with one exception: a note that
  // is already EVERYONE has to show what it currently is, or the picker would silently misreport the
  // audience of a note somebody can still see. It is disabled in that case — the permission was taken
  // away, and the server will refuse to save until they pick something else.
  const lostBroadcast = !canBroadcast && visibility === "EVERYONE";
  const options = VISIBILITY_OPTIONS.filter((o) => o.value !== "EVERYONE" || canBroadcast || lostBroadcast);
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === visibility);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSaving(true);

    // Sent in full on both paths. `pinned` is a real boolean rather than a checkbox's "on"/"" —
    // zod would reject the string, and the note would quietly refuse to save.
    const fields = {
      title: title.trim(),
      body: body.trim(),
      color,
      visibility,
      pinned,
      // Always sent, never omitted. The action replaces the row rather than patching it, so a
      // missing value here would cancel a reminder as a side effect of editing the text. Sent as
      // typed: the action reads it on the workspace's clock.
      remindAt,
    };
    const result = note
      ? await updateNote({ id: note.id, ...fields })
      : await createNote({
          ...fields,
          companyId: defaults?.companyId ?? "",
          leadId: defaults?.leadId ?? "",
          ticketId: defaults?.ticketId ?? "",
        });

    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved?.();
    onClose();
  }

  return (
    <Dialog open={open} onClose={onClose} title={note ? "Edit note" : "New note"}>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <p className="rounded-base bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="space-y-1.5">
          <Label htmlFor="note-title">Title (optional)</Label>
          <Input
            id="note-title"
            value={title}
            maxLength={NOTE_TITLE_MAX}
            placeholder="What is this about?"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="note-body">Note</Label>
          <Textarea
            id="note-body"
            value={body}
            maxLength={NOTE_BODY_MAX}
            rows={6}
            autoFocus
            placeholder="They always order in March…"
            onChange={(e) => setBody(e.target.value)}
          />
          <p className="text-right text-xs text-subtle">
            {body.length} / {NOTE_BODY_MAX}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label>Colour</Label>
          <div className="flex flex-wrap gap-2">
            {noteColorValues.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={noteColorLabel(value)}
                aria-pressed={color === value}
                title={noteColorLabel(value)}
                onClick={() => setColor(value)}
                className={cn(
                  "grid h-8 w-8 place-items-center rounded-full border transition-transform duration-150 hover:scale-110",
                  noteColorClasses[value],
                  // `ring-brand` is the app's own utility and sets box-shadow outright, so it is
                  // used alone rather than composed with Tailwind's `ring-*` scale.
                  color === value && "border-brand ring-brand",
                )}
              >
                {color === value && <Check className="h-4 w-4 text-text" />}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Who can see it</Label>
          <div className="flex flex-wrap gap-2">
            {options.map((option) => {
              const Icon = option.icon;
              const disabled = option.value === "EVERYONE" && lostBroadcast;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={disabled}
                  aria-pressed={visibility === option.value}
                  onClick={() => setVisibility(option.value)}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-base border px-3 text-sm transition-colors",
                    "disabled:cursor-not-allowed disabled:opacity-55",
                    visibility === option.value
                      ? "border-brand bg-brand-subtle text-brand"
                      : "border-line-strong bg-surface text-muted hover:bg-surface-sunken hover:text-text",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {option.label}
                </button>
              );
            })}
          </div>
          {selected && <p className="text-xs text-subtle">{selected.hint}</p>}
          {lostBroadcast && (
            <p className="text-xs text-warning">
              You no longer have permission to post to everyone. Choose another audience to save this note.
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.target.checked)}
            className="h-4 w-4 rounded border-line-strong"
          />
          Pin to the top of the board
        </label>

        <div className="space-y-1.5">
          <Label htmlFor="note-remind">Remind me ({clock.zone.replace(/_/g, " ")} time)</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="note-remind"
              type="datetime-local"
              value={remindAt}
              onChange={(e) => setRemindAt(e.target.value)}
              className="w-auto"
            />
            {QUICK_REMINDERS.map((q) => (
              <Button key={q.label} type="button" variant="ghost" size="sm" onClick={() => setRemindAt(clock.input(q.at(clock)))}>
                {q.label}
              </Button>
            ))}
            {remindAt && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setRemindAt("")}>
                Clear
              </Button>
            )}
          </div>
          <p className="text-xs text-subtle">
            {/* Said plainly, because a reminder that silently went to nobody else is the kind of
                thing people only discover afterwards. */}
            Only you are reminded, even on a shared note. To put a deadline on somebody else, make
            it a task.
          </p>
        </div>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving || body.trim().length === 0}>
            {saving ? "Saving…" : note ? "Save" : "Add note"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
