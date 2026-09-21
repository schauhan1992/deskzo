"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Pin, Plus } from "lucide-react";
import { createNote, listNotes, type NoteListItem } from "@/actions/note";
import { Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Somewhere to write something down without losing the page you were on.
 *
 * That is the entire case for this being in the rail: the moment you need to note a number is the
 * moment it is on screen, and navigating to the notes board to write it down is how the number gets
 * mistyped. Pinned notes come first because those are the ones people keep on screen on purpose.
 *
 * Read-and-add only. Editing, colours, reminders and reordering all live on the board — a panel
 * that grew those would be the board in a narrower box, and the reason to open this is that it is
 * quicker than the board.
 */
export function RailNotes() {
  const router = useRouter();
  const [rows, setRows] = useState<NoteListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let live = true;
    listNotes()
      .then((result) => live && setRows(result))
      .catch(() => live && setError("Could not load your notes."));
    return () => {
      live = false;
    };
  }, []);

  const shown = rows ? [...rows].sort((a, b) => Number(b.pinned) - Number(a.pinned)).slice(0, 12) : null;

  return (
    <div className="space-y-3">
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const text = body.trim();
          if (!text) return;
          startTransition(async () => {
            const result = await createNote({ body: text, visibility: "PRIVATE" });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setBody("");
            setError(null);
            setRows(await listNotes());
            router.refresh();
          });
        }}
      >
        <Textarea
          rows={3}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Jot something down…"
          aria-label="New note"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={pending || !body.trim()} className="w-full">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {pending ? "Saving…" : "Add note"}
        </Button>
      </form>

      {error && <p className="text-xs text-danger">{error}</p>}
      {!shown && !error && <p className="text-sm text-muted">Loading…</p>}

      {shown?.length === 0 && (
        <p className="rounded-base bg-surface-sunken px-3 py-6 text-center text-sm text-muted">
          Nothing on the board yet.
        </p>
      )}

      {shown && shown.length > 0 && (
        <ul className="space-y-1.5">
          {shown.map((note) => (
            <li key={note.id} className="rounded-base border border-line px-2.5 py-2">
              <div className="flex items-start gap-1.5">
                {note.pinned && <Pin className="mt-0.5 h-3 w-3 shrink-0 fill-brand text-brand" aria-label="Pinned" />}
                <div className="min-w-0">
                  {note.title && <div className="text-sm font-medium text-text">{note.title}</div>}
                  {/* Trimmed rather than scrolled. A note long enough to need scrolling is one to
                      open on the board, where it can actually be read and edited. */}
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted">{note.body}</p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Link href="/notes" className="block text-xs text-brand hover:underline">
        Open the notes board →
      </Link>
    </div>
  );
}
