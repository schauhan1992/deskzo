import { canBroadcastNotes, listNotes } from "@/actions/note";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { NotesBoard } from "@/components/notes/notes-board";

export default async function NotesPage() {
  const enabled = await isModuleEnabled("notes");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="notes" />;
  }

  // Archived notes are fetched with the rest and hidden by the board. The archive toggle is a thing
  // people flick on to find one note and straight back off again, and a page reload each way is a
  // poor trade for a list this small.
  const [notes, canBroadcast] = await Promise.all([listNotes({ includeArchived: true }), canBroadcastNotes()]);

  const live = notes.filter((note) => note.archivedAt === null);
  const mine = live.filter((note) => note.canEdit).length;

  return (
    <div>
      <div>
        <h1 className="text-xl font-semibold text-text">Sticky Notes</h1>
        <p className="mt-1 text-sm text-muted">
          {live.length} on the board · {mine} yours
          {live.length - mine > 0 && ` · ${live.length - mine} shared with you`}
        </p>
      </div>

      <div className="mt-6">
        <NotesBoard notes={notes} canBroadcast={canBroadcast} />
      </div>
    </div>
  );
}
