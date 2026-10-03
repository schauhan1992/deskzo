"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Archive, Pencil, Pin, PinOff, Plus } from "lucide-react";
import { listNotes, setNoteArchived, updateNote, type NoteListItem } from "@/actions/note";
import { NoteDialog } from "@/components/notes/note-dialog";
import { noteColorClasses } from "@/components/notes/note-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { IconButton } from "@/components/ui/icon-button";
import { useClock } from "@/components/time/clock-provider";
import { cn } from "@/lib/utils";
import type { NoteVisibility } from "@/lib/validation/note";

/**
 * Who else can see this, and nothing at all for a private note — the same rule the board card uses,
 * so the two views never disagree about what a note is. PRIVATE is the default and the common case;
 * a "Just me" on every row would teach people to stop reading the row that matters.
 */
const sharedWith: Partial<Record<NoteVisibility, string>> = {
  TEAM: "Team",
  EVERYONE: "Everyone",
};

/**
 * When a note gets a "Show more".
 *
 * Measuring whether the clamped text actually overflowed would mean reading layout during render,
 * which React 19 does not allow, so this guesses from the text instead. Guessing wrong is cheap in
 * one direction only — a pointless toggle on a note that happened to fit — so the threshold sits
 * comfortably above two lines rather than trying to be exact.
 */
const PREVIEW_CHARS = 140;

type Mutation = () => Promise<{ ok: true } | { ok: false; error: string }>;

/**
 * The notes stuck to one record, on that record's own page.
 *
 * Deliberately not a second board. The board at /notes is where somebody arranges their own
 * thinking and drags cards around; this is a margin note on an account already open in front of
 * you — "they always order in March", "don't ring before 11" — so it stays stacked and tight, shows
 * the first couple of lines, and opens the rest in place rather than sending anybody elsewhere.
 * Colours come from the board's palette rather than a second set, because a note somebody made
 * amber has to still be the amber one when they meet it here.
 *
 * The list is fetched here rather than passed down from the page. A note written from this panel
 * has to appear in it straight away, and the pages this mounts on are server components carrying a
 * dozen other queries — re-running `listNotes` costs one of them, re-running the page costs all of
 * them. Both gates that decide what comes back live in the action, so nothing about who may read
 * what is being decided on the client.
 */
export function RecordNotes({
  companyId,
  leadId,
  ticketId,
  canBroadcast,
}: {
  companyId?: string;
  leadId?: string;
  ticketId?: string;
  /** Whether to offer "Everyone" in the composer at all, rather than offering it and failing. */
  canBroadcast: boolean;
}) {
  const clock = useClock();
  // `null` is "not loaded yet" and is the only state that shows a loading line. A reload after a
  // change leaves the notes on screen while it runs, so a pin toggle doesn't blank the panel.
  const [notes, setNotes] = useState<NoteListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<NoteListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [, startTransition] = useTransition();

  useEffect(() => {
    // A response that arrives after the record changed, or after a newer reload started, is thrown
    // away — otherwise the older list can land last and quietly replace the newer one.
    let current = true;
    listNotes({ companyId, leadId, ticketId })
      .then((rows) => {
        if (current) setNotes(rows);
      })
      .catch(() => {
        if (!current) return;
        setNotes([]);
        setError("Couldn't load notes.");
      });
    return () => {
      current = false;
    };
  }, [companyId, leadId, ticketId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  function mutate(noteId: string, run: Mutation) {
    setBusyId(noteId);
    setError(null);
    startTransition(async () => {
      const result = await run();
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      reload();
    });
  }

  function togglePin(note: NoteListItem) {
    // `updateNote` replaces the note rather than patching it: colour, visibility and pinned all
    // carry defaults, so anything left out of this call comes back as YELLOW, PRIVATE and unpinned.
    // The whole note goes back with only the pin flipped.
    mutate(note.id, () =>
      updateNote({
        id: note.id,
        title: note.title ?? "",
        body: note.body,
        color: note.color,
        visibility: note.visibility,
        pinned: !note.pinned,
      }),
    );
  }

  function closeComposer() {
    setComposerOpen(false);
    setEditingNote(null);
  }

  const rows = notes ?? [];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3 text-sm font-medium text-text">
        <span>
          Notes
          {rows.length > 0 && <span className="ml-1.5 font-normal text-subtle">{rows.length}</span>}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setEditingNote(null);
            setComposerOpen(true);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add note
        </Button>
      </CardHeader>

      <CardContent className="space-y-2">
        {error && <p className="text-xs text-danger">{error}</p>}

        {notes === null && <p className="py-4 text-center text-sm text-subtle">Loading…</p>}

        {notes !== null && rows.length === 0 && (
          <p className="py-4 text-center text-sm text-subtle">Nothing stuck to this record yet.</p>
        )}

        {rows.map((note) => {
          const isOpen = expanded[note.id] ?? false;
          const needsToggle = note.body.length > PREVIEW_CHARS || note.body.split("\n").length > 2;
          const shared = sharedWith[note.visibility];

          return (
            <div
              key={note.id}
              className={cn(
                "group rounded-base border px-3 py-2 transition-opacity",
                noteColorClasses[note.color],
                busyId === note.id && "pointer-events-none opacity-50",
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  {(note.title || note.pinned) && (
                    <div className="flex items-center gap-1.5">
                      {note.pinned && (
                        <>
                          <Pin aria-hidden className="h-3 w-3 shrink-0 text-muted" />
                          <span className="sr-only">Pinned</span>
                        </>
                      )}
                      {note.title && (
                        <p className="truncate text-[13px] font-semibold text-text">{note.title}</p>
                      )}
                    </div>
                  )}

                  {/* A note is written with its line breaks meaning something — three things on
                      three lines is a list, and reflowing it into a paragraph loses the list. */}
                  <p
                    className={cn(
                      "whitespace-pre-wrap break-words text-[13px] leading-snug text-text",
                      note.title && "mt-0.5",
                      !isOpen && "line-clamp-2",
                    )}
                  >
                    {note.body}
                  </p>

                  {needsToggle && (
                    <button
                      type="button"
                      onClick={() => setExpanded((prev) => ({ ...prev, [note.id]: !isOpen }))}
                      className="mt-0.5 text-[11px] font-medium text-muted transition-colors hover:text-text"
                    >
                      {isOpen ? "Show less" : "Show more"}
                    </button>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted">
                    <span className="truncate">{note.ownerName}</span>
                    <span aria-hidden>·</span>
                    <span>{clock.date(note.updatedAt)}</span>
                    {shared && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{shared}</span>
                      </>
                    )}
                  </div>
                </div>

                {/* `canEdit` is the server's answer to "is this mine", and the only thing these are
                    gated on — no permission lets anybody edit somebody else's note. Held at sixty
                    percent rather than hidden until hover, because an action that only appears on
                    hover cannot be found at all on a touchscreen. */}
                {note.canEdit && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                    <IconButton
                      icon={note.pinned ? PinOff : Pin}
                      label={note.pinned ? "Unpin note" : "Pin note"}
                      onClick={() => togglePin(note)}
                    />
                    <IconButton
                      icon={Pencil}
                      label="Edit note"
                      onClick={() => {
                        setEditingNote(note);
                        setComposerOpen(true);
                      }}
                    />
                    {/* Archive, not delete. Clearing a note off an account is the everyday gesture
                        and this is the reversible version of it; the board is where somebody who
                        has decided a note should stop existing goes to do that. */}
                    <IconButton
                      icon={Archive}
                      label="Archive note"
                      onClick={() => mutate(note.id, () => setNoteArchived(note.id, true))}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>

      <NoteDialog
        open={composerOpen}
        onClose={closeComposer}
        note={editingNote}
        defaults={{ companyId, leadId, ticketId }}
        canBroadcast={canBroadcast}
        onSaved={() => {
          closeComposer();
          reload();
        }}
      />
    </Card>
  );
}
