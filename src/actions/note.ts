"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { mayAttachTo } from "@/lib/authz/attachments";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { accountScopeIds } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { createNoteSchema, updateNoteSchema, reorderNotesSchema } from "@/lib/validation/note";
import type { NoteColor, NoteVisibility } from "@/lib/validation/note";
import type { ActionResult } from "@/actions/company";

/**
 * Sticky notes.
 *
 * Two independent gates decide whether somebody may read a note, and a note has to clear both.
 *
 * ## The visibility gate — who the note was written for
 *
 *   PRIVATE   the owner, and nobody else. Not an admin, not a super admin. There is deliberately no
 *             permission that lifts it: a scratchpad somebody else can read is not a scratchpad, and
 *             a person who suspects otherwise simply stops writing in it.
 *   TEAM      the owner, and anyone sharing their department. Equal and non-null on both sides, so
 *             an owner with no department keeps their TEAM notes to themselves — TEAM collapses to
 *             PRIVATE rather than to "everyone with a null department", which is the failure the
 *             non-null requirement exists to prevent.
 *   EVERYONE  any signed-in user, and only writable by someone holding `notes.broadcast`.
 *
 * Department was chosen over the reporting line because it is symmetric by construction: if you can
 * read my TEAM notes then I can read yours, and neither of us has to work out which direction the
 * org chart runs to predict what we are sharing. A rule people can hold in their heads is a rule
 * they will use correctly.
 *
 * ## The record gate — what the note is stuck to
 *
 * A note attached to a company, a lead or a ticket is also hidden from anybody who cannot see that
 * company under the account scoping in src/lib/authz/company-scope.ts, whatever its visibility says.
 * Without this an EVERYONE note on an account is a way to read an account you were not given, and
 * "they always order in March" is exactly the sort of thing somebody would broadcast.
 *
 * ## Why the clause is built once
 *
 * Same reasoning as company-scope.ts: a filter written per call site is a filter that will be wrong
 * at one of them, and the wrong direction is silent. Nobody reports seeing a note they should not
 * have seen, because nothing tells them it was not meant for them. So every read in this file goes
 * through `readableNotesWhere` and none of them assemble their own.
 */

/** Pinned to the top, then the owner's manual order, then most recently touched. */
/**
 * The reminder cell, as an instant or nothing.
 *
 * An unparseable value is treated as "no reminder" rather than refused. That is the safe
 * direction here and only here: the alternative is an edit to the note's text being rejected
 * because of a date field the person did not touch, and a note somebody cannot save is worse than
 * a reminder they have to set again. The picker only ever sends an ISO string or "".
 */
function parseRemindAt(value: string | undefined): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

const NOTE_ORDER = [{ pinned: "desc" }, { position: "asc" }, { updatedAt: "desc" }] satisfies Prisma.StickyNoteOrderByWithRelationInput[];

const noteSelect = {
  id: true,
  noteSeq: true,
  title: true,
  body: true,
  color: true,
  visibility: true,
  pinned: true,
  position: true,
  remindAt: true,
  ownerUserId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { name: true } },
  company: { select: { id: true, name: true } },
  lead: { select: { id: true, title: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
} satisfies Prisma.StickyNoteSelect;

export type NoteListItem = {
  id: string;
  noteSeq: number;
  title: string | null;
  body: string;
  color: NoteColor;
  visibility: NoteVisibility;
  pinned: boolean;
  position: number;
  remindAt: Date | null;
  /**
   * Whether that moment has passed, decided here rather than in the card.
   *
   * The component that shows this renders on the client, and a client that reads the clock
   * during render is doing something React will not promise to keep stable — the compiler
   * refuses it outright. The server already has an authoritative now, and it is the same now the
   * reminder sweep uses, so the two can never disagree about whether a note has fired.
   */
  remindDue: boolean;
  ownerUserId: string;
  ownerName: string;
  /** True only for the owner. Carried on the row so the board never has to work it out itself. */
  canEdit: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  company: { id: string; name: string } | null;
  lead: { id: string; title: string } | null;
  ticket: { id: string; ticketSeq: number; title: string } | null;
};

/**
 * Everything the signed-in user may read, as one `where`.
 *
 * The two gates are ANDed: `OR` holds the visibility test, `AND` holds the record test. Note that
 * the record test applies to the owner's own notes too. That is deliberate — if an account is
 * reassigned away from you, the note you stuck to it goes with the account rather than following
 * you, because the alternative leaves a copy of the account's details on a board the account
 * manager cannot see or correct.
 */
async function readableNotesWhere(userId: string): Promise<Prisma.StickyNoteWhereInput> {
  const [viewer, scopeIds] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { departmentId: true } }),
    accountScopeIds(userId),
  ]);

  const visible: Prisma.StickyNoteWhereInput[] = [{ ownerUserId: userId }, { visibility: "EVERYONE" }];
  // Only when the viewer has a department of their own. Omitting the branch entirely is what stops
  // two people with no department from forming an accidental team of everybody unassigned.
  if (viewer?.departmentId) {
    visible.push({ visibility: "TEAM", owner: { departmentId: viewer.departmentId } });
  }

  // `null` means the viewer holds `companies.viewAll`, so there is no account to scope through and
  // the record test has nothing to say.
  if (scopeIds === null) return { OR: visible };

  const inScope: Prisma.CompanyWhereInput = { ownerUserId: { in: scopeIds } };
  return {
    OR: visible,
    AND: [
      { OR: [{ companyId: null }, { company: inScope }] },
      { OR: [{ leadId: null }, { lead: { company: inScope } }] },
      { OR: [{ ticketId: null }, { ticket: { company: inScope } }] },
    ],
  };
}

/**
 * Whether the caller may stick a note to these records in the first place.
 *
 * The read gate already hides a note on an account you cannot see, so this is not what stops the
 * leak — it stops the mirror image of it. Without this, somebody could write onto an account they
 * were never given, and the colleagues who *can* see that account would find text there from a
 * person with no business on it, with nothing recording how it arrived.
 *
 * Existence is checked on every path, including for a viewer who holds `companies.viewAll` and is
 * therefore subject to no scope at all. Returning early for them would hand a made-up id straight
 * to `create`, where the foreign key rejects it as a raw database error rather than as the "no such
 * record" this function exists to say.
 */
const canAttachTo = mayAttachTo;

function revalidateNotePaths(note: { companyId: string | null; leadId: string | null; ticketId: string | null }) {
  revalidatePath("/notes");
  if (note.companyId) revalidatePath(`/companies/${note.companyId}`);
  if (note.leadId) revalidatePath(`/leads/${note.leadId}`);
  if (note.ticketId) revalidatePath(`/tickets/${note.ticketId}`);
}

/**
 * The note as the caller is allowed to change it, or null.
 *
 * Only the owner may edit, archive or delete a note. There is no "manage anyone's notes" permission
 * and there should not be one — the same argument as PRIVATE. A missing note and somebody else's
 * note return the same null, so the caller cannot use the error message to learn that a note exists.
 *
 * `ownerUserId` sits in the `where` rather than being compared after the row comes back. The two
 * read the same on a good day, but a fetch-then-compare states the rule in a place the database
 * cannot enforce, so it holds only as long as every later edit of this file remembers to re-check —
 * and the write that follows it is a second query with its own `where`. The writes below therefore
 * repeat the ownership clause instead of trusting this lookup: this function decides what to *say*
 * to the caller, and the write decides what actually happens.
 */
async function ownedNote(noteId: string, userId: string) {
  return db.stickyNote.findFirst({
    where: { id: noteId, ownerUserId: userId },
    select: { id: true, title: true, ownerUserId: true, companyId: true, leadId: true, ticketId: true },
  });
}

/** What the audit log shows for a note, which must not be the note's contents. */
function noteLabel(note: { title: string | null; id: string }): string {
  return note.title?.trim() || `Note ${note.id.slice(-6)}`;
}

type NoteListParams = {
  includeArchived?: boolean;
  companyId?: string;
  leadId?: string;
  ticketId?: string;
};

export async function listNotes(params?: NoteListParams): Promise<NoteListItem[]> {
  const user = await requireModuleUser("notes");

  const rows = await db.stickyNote.findMany({
    where: {
      AND: [
        await readableNotesWhere(user.id),
        {
          ...(params?.includeArchived ? {} : { archivedAt: null }),
          ...(params?.companyId ? { companyId: params.companyId } : {}),
          ...(params?.leadId ? { leadId: params.leadId } : {}),
          ...(params?.ticketId ? { ticketId: params.ticketId } : {}),
        },
      ],
    },
    orderBy: NOTE_ORDER,
    select: noteSelect,
  });

  const now = Date.now();
  return rows.map(({ owner, ...note }) => ({
    ...note,
    ownerName: owner.name,
    canEdit: note.ownerUserId === user.id,
    remindDue: note.remindAt !== null && note.remindAt.getTime() <= now,
  }));
}

export async function createNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("notes");
  const parsed = createNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const remindAt = parseRemindAt(data.remindAt);

  if (data.visibility === "EVERYONE" && !(await can(user.id, "notes.broadcast"))) {
    return { ok: false, error: "You can't put a note on everybody's board." };
  }

  const attachments = {
    companyId: data.companyId || null,
    leadId: data.leadId || null,
    ticketId: data.ticketId || null,
  };
  if (!(await canAttachTo(user.id, attachments))) {
    return { ok: false, error: "You can't stick a note to a record you don't have access to." };
  }

  // A new note goes to the front of its owner's board rather than the end. Somebody who just wrote
  // something down is not looking for it at the bottom of forty others.
  const lowest = await db.stickyNote.aggregate({
    where: { ownerUserId: user.id, archivedAt: null },
    _min: { position: true },
  });

  const note = await db.stickyNote.create({
    data: {
      ...attachments,
      title: data.title || null,
      body: data.body,
      color: data.color,
      visibility: data.visibility,
      pinned: data.pinned,
      remindAt,
      position: (lowest._min.position ?? 0) - 1,
      ownerUserId: user.id,
    },
    select: { id: true, title: true, companyId: true, leadId: true, ticketId: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "StickyNote",
    entityId: note.id,
    entityLabel: noteLabel(note),
  });

  revalidateNotePaths(note);
  return { ok: true, data: { id: note.id } };
}

export async function updateNote(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("notes");
  const parsed = updateNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const data = parsed.data;
  const remindAt = parseRemindAt(data.remindAt);

  const existing = await ownedNote(data.id, user.id);
  if (!existing) {
    return { ok: false, error: "Note not found." };
  }

  // Checked here as well as on create, and this is the half that matters: without it, anybody can
  // write a PRIVATE note and then edit it to EVERYONE, and the permission guards nothing.
  if (data.visibility === "EVERYONE" && !(await can(user.id, "notes.broadcast"))) {
    return { ok: false, error: "You can't put a note on everybody's board." };
  }

  // `updateMany` rather than `update`, for the `ownerUserId` in the `where`: the row is selected and
  // written in one statement, so the check cannot be true when it is made and false when it lands.
  // A count of zero means the note stopped being the caller's between the lookup above and here,
  // and the same "Note not found." is returned as for a note that never existed.
  const written = await db.stickyNote.updateMany({
    where: { id: data.id, ownerUserId: user.id },
    data: {
      title: data.title || null,
      body: data.body,
      color: data.color,
      visibility: data.visibility,
      pinned: data.pinned,
      remindAt,
    },
  });
  if (written.count === 0) {
    return { ok: false, error: "Note not found." };
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "StickyNote",
    entityId: data.id,
    // The new title, not the one the note had when it was looked up — the audit row should name the
    // note as it now stands.
    entityLabel: noteLabel({ title: data.title || null, id: data.id }),
  });

  // Attachments are immutable by design (see updateNoteSchema), so the paths to revalidate are the
  // ones the note already had.
  revalidateNotePaths(existing);
  return { ok: true, data: { id: data.id } };
}

export async function setNoteArchived(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notes");
  const existing = await ownedNote(id, user.id);
  if (!existing) {
    return { ok: false, error: "Note not found." };
  }

  const written = await db.stickyNote.updateMany({
    where: { id, ownerUserId: user.id },
    data: { archivedAt: archived ? new Date() : null },
  });
  if (written.count === 0) {
    return { ok: false, error: "Note not found." };
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "StickyNote",
    entityId: id,
    entityLabel: `${archived ? "Archived" : "Restored"} — ${noteLabel(existing)}`,
  });

  revalidateNotePaths(existing);
  return { ok: true, data: null };
}

/**
 * A real delete, and the only one. Archiving is the reversible option and it already exists, so
 * somebody reaching for this has decided the note should stop existing.
 */
export async function deleteNote(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notes");
  const existing = await ownedNote(id, user.id);
  if (!existing) {
    return { ok: false, error: "Note not found." };
  }

  const removed = await db.stickyNote.deleteMany({ where: { id, ownerUserId: user.id } });
  if (removed.count === 0) {
    return { ok: false, error: "Note not found." };
  }

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "StickyNote",
    entityId: id,
    entityLabel: noteLabel(existing),
  });

  revalidateNotePaths(existing);
  return { ok: true, data: null };
}

export async function reorderNotes(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("notes");
  const parsed = reorderNotesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Deduplicated first, keeping the first occurrence. A repeated id would otherwise be written twice
  // with two different positions, and the last write would win — so the one card the user dragged is
  // the one that lands somewhere they did not put it.
  const requested = [...new Set(parsed.data.ids)];

  // Filtered against what the caller actually owns rather than refused outright: a board shows other
  // people's notes alongside your own, so an id you cannot move arriving in the list is an ordinary
  // consequence of dragging, not an attack. The ids that survive keep their relative order.
  const owned = await db.stickyNote.findMany({
    where: { id: { in: requested }, ownerUserId: user.id },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((note) => note.id));
  const ordered = requested.filter((id) => ownedIds.has(id));
  if (ordered.length === 0) {
    return { ok: true, data: null };
  }

  // Ownership is repeated in each statement's `where` for the same reason as the other writes: the
  // filter above says which ids to send, but only the clause inside the write decides which rows are
  // allowed to move.
  await db.$transaction(async (tx) => {
    for (const op of ordered.map((id, index) =>
      tx.stickyNote.updateMany({ where: { id, ownerUserId: user.id }, data: { position: index } }),
    )) await op;
  });

  // One row for the board rather than one per note. A drag touches every card on screen, and an
  // audit log with forty rows per rearrangement is a log nobody reads when it matters.
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "StickyNote",
    entityId: ordered[0],
    entityLabel: `Reordered ${ordered.length} note${ordered.length === 1 ? "" : "s"}`,
  });

  revalidatePath("/notes");
  return { ok: true, data: null };
}

/** Whether to offer "Everyone" in the visibility picker at all, rather than offering it and failing. */
export async function canBroadcastNotes(): Promise<boolean> {
  const user = await requireModuleUser("notes");
  return can(user.id, "notes.broadcast");
}
