"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Archive, Plus, Search } from "lucide-react";
import type { NoteListItem } from "@/actions/note";
import { deleteNote, reorderNotes, setNoteArchived, updateNote } from "@/actions/note";
import { noteColorValues, type NoteColor } from "@/lib/validation/note";
import { NoteCard, noteColorClasses, noteColorLabel } from "@/components/notes/note-card";
import { NoteDialog } from "@/components/notes/note-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type OwnerFilter = "ALL" | "MINE" | "SHARED";

/**
 * Keeps the optimistic order honest about the one thing the server will override.
 *
 * `listNotes` orders pinned notes first and only then by `position`, so dragging an unpinned card
 * above a pinned one would look right for a second and then snap back on the next refresh. Sorting
 * the same way locally means what you see after a drop is what you get after the round trip. The
 * sort is stable, so within each group the order you dragged the cards into survives untouched.
 */
function pinnedFirst(notes: NoteListItem[]): NoteListItem[] {
  return [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

/**
 * The board.
 *
 * Takes the full list including archived notes and filters in the browser rather than through the
 * URL. Filtering a wall of sticky notes is something people do repeatedly and undo immediately —
 * three colours, then back to all, then a search — and a server round trip per keystroke turns a
 * glance into a wait. The list is one person's notes, so it is small enough that this is free.
 */
export function NotesBoard({
  notes,
  canBroadcast = false,
  showNewButton = true,
}: {
  notes: NoteListItem[];
  canBroadcast?: boolean;
  showNewButton?: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState(notes);
  const [syncedNotes, setSyncedNotes] = useState(notes);
  const [query, setQuery] = useState("");
  const [colorFilter, setColorFilter] = useState<NoteColor | "ALL">("ALL");
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>("ALL");
  const [showArchived, setShowArchived] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<NoteListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<NoteListItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Re-sync the optimistic order when the server hands back a fresh list, adjusted during render
  // rather than in an effect — the same pattern as the leads board.
  if (notes !== syncedNotes) {
    setSyncedNotes(notes);
    setItems(notes);
  }

  const needle = query.trim().toLowerCase();
  const visible = items.filter((note) => {
    if (!showArchived && note.archivedAt !== null) return false;
    if (showArchived && note.archivedAt === null) return false;
    if (colorFilter !== "ALL" && note.color !== colorFilter) return false;
    if (ownerFilter === "MINE" && !note.canEdit) return false;
    if (ownerFilter === "SHARED" && note.canEdit) return false;
    if (needle && !`${note.title ?? ""}\n${note.body}`.toLowerCase().includes(needle)) return false;
    return true;
  });

  const archivedCount = items.filter((note) => note.archivedAt !== null).length;

  function openNew() {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(note: NoteListItem) {
    setEditing(note);
    setDialogOpen(true);
  }

  /**
   * Toggle the pin.
   *
   * Sends every field, not just `pinned`. `updateNote` replaces the row, so a request carrying only
   * the new pin state would also reset the note to yellow and private on its way past.
   */
  function togglePin(note: NoteListItem) {
    setError(null);
    setBusyId(note.id);
    startTransition(async () => {
      const result = await updateNote({
        id: note.id,
        title: note.title ?? "",
        body: note.body,
        color: note.color,
        visibility: note.visibility,
        pinned: !note.pinned,
      });
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function toggleArchive(note: NoteListItem) {
    setError(null);
    setBusyId(note.id);
    startTransition(async () => {
      const result = await setNoteArchived(note.id, note.archivedAt === null);
      setBusyId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setError(null);
    startTransition(async () => {
      const result = await deleteNote(id);
      setDeleteTarget(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  /**
   * Drop the dragged note where the target one sits.
   *
   * The whole board order goes to the server, not just the cards currently passing the filters. The
   * action keeps the ids the caller owns and numbers them 0..n-1, so sending a filtered subset would
   * renumber those few from zero and shuffle everything a filter happened to be hiding.
   */
  function handleDrop(targetId: string) {
    const id = draggedId;
    setDraggedId(null);
    setDragOverId(null);
    if (!id || id === targetId) return;

    const from = items.findIndex((note) => note.id === id);
    const to = items.findIndex((note) => note.id === targetId);
    if (from === -1 || to === -1) return;

    const previous = items;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    const ordered = pinnedFirst(next);

    setError(null);
    setItems(ordered);

    startTransition(async () => {
      const result = await reorderNotes({ ids: ordered.map((note) => note.id) });
      if (!result.ok) {
        setItems(previous);
        setError(result.error);
        router.refresh();
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search notes…"
            aria-label="Search notes"
            className="w-56 pl-8"
          />
        </div>

        <Select
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value as OwnerFilter)}
          aria-label="Whose notes"
          className="w-40"
        >
          <option value="ALL">All notes</option>
          <option value="MINE">Mine</option>
          <option value="SHARED">Shared with me</option>
        </Select>

        <div className="flex items-center gap-1.5" role="group" aria-label="Filter by colour">
          <button
            type="button"
            aria-pressed={colorFilter === "ALL"}
            onClick={() => setColorFilter("ALL")}
            className={cn(
              "h-7 rounded-full border border-line-strong px-2.5 text-xs transition-colors",
              colorFilter === "ALL" ? "border-brand bg-brand-subtle text-brand" : "text-muted hover:bg-surface-sunken",
            )}
          >
            All
          </button>
          {noteColorValues.map((value) => (
            <button
              key={value}
              type="button"
              title={noteColorLabel(value)}
              aria-label={noteColorLabel(value)}
              aria-pressed={colorFilter === value}
              onClick={() => setColorFilter((prev) => (prev === value ? "ALL" : value))}
              className={cn(
                "h-6 w-6 rounded-full border transition-transform duration-150 hover:scale-110",
                noteColorClasses[value],
                colorFilter === value && "border-brand ring-brand",
              )}
            />
          ))}
        </div>

        <Button
          type="button"
          variant={showArchived ? "subtle" : "ghost"}
          size="sm"
          aria-pressed={showArchived}
          onClick={() => setShowArchived((v) => !v)}
        >
          <Archive className="h-3.5 w-3.5" />
          Archived{archivedCount > 0 && ` (${archivedCount})`}
        </Button>

        {showNewButton && (
          <Button type="button" size="sm" className="ml-auto" onClick={openNew}>
            <Plus className="h-4 w-4" />
            New note
          </Button>
        )}
      </div>

      {error && <div className="rounded-base bg-danger-bg px-3 py-2 text-sm text-danger">{error}</div>}

      {visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-12 text-center">
          <p className="text-sm text-muted">
            {items.length === 0 ? "Nothing on the board yet." : "No notes match these filters."}
          </p>
          {items.length === 0 && showNewButton && (
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={openNew}>
              <Plus className="h-4 w-4" />
              Write the first one
            </Button>
          )}
        </div>
      ) : (
        // CSS multi-column rather than a grid: notes are different lengths, and a grid would pad
        // every row out to its tallest card and leave holes down the board.
        <div className="columns-1 gap-3 sm:columns-2 lg:columns-3 xl:columns-4">
          {visible.map((note) => (
            <div
              key={note.id}
              // Only your own notes move. Somebody else's card has no position of yours to change,
              // and the server would discard the id anyway.
              draggable={note.canEdit}
              onDragStart={(e) => {
                setDraggedId(note.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", note.id);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragOver={(e) => {
                if (!draggedId) return;
                e.preventDefault();
                if (dragOverId !== note.id) setDragOverId(note.id);
              }}
              onDragLeave={() => setDragOverId((prev) => (prev === note.id ? null : prev))}
              onDrop={(e) => {
                e.preventDefault();
                handleDrop(note.id);
              }}
              className={cn(
                "mb-3 break-inside-avoid rounded-xl",
                note.canEdit && "cursor-grab active:cursor-grabbing",
                draggedId === note.id && "opacity-40",
                dragOverId === note.id && draggedId !== note.id && "ring-brand",
              )}
            >
              <NoteCard
                note={note}
                busy={busyId === note.id}
                onEdit={openEdit}
                onTogglePin={togglePin}
                onArchive={toggleArchive}
                onDelete={setDeleteTarget}
              />
            </div>
          ))}
        </div>
      )}

      <NoteDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        note={editing}
        canBroadcast={canBroadcast}
        onSaved={() => router.refresh()}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete note">
        <p className="text-sm text-muted">
          Delete this note for good? Archiving keeps it findable; this does not.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
