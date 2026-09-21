import { z } from "zod";

/**
 * Mirrors `StickyNoteColor` in the schema, written out rather than derived from `@prisma/client`.
 * The board renders a swatch per colour, and a client component cannot import the Prisma runtime —
 * so the list has to exist somewhere a client component can reach, and this is that place.
 */
export const noteColorValues = ["YELLOW", "GREEN", "BLUE", "PINK", "PURPLE", "ORANGE", "GREY"] as const;

/**
 * Mirrors `StickyNoteVisibility`. Note that EVERYONE is accepted here and refused in the action:
 * a schema cannot ask who the caller is, and `notes.broadcast` is a question about the caller.
 */
export const noteVisibilityValues = ["PRIVATE", "TEAM", "EVERYONE"] as const;

export type NoteColor = (typeof noteColorValues)[number];
export type NoteVisibility = (typeof noteVisibilityValues)[number];

export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 5000;

export const createNoteSchema = z.object({
  title: z.string().trim().max(NOTE_TITLE_MAX, "Keep the title short").optional().or(z.literal("")),
  body: z.string().trim().min(1, "A note needs something written in it").max(NOTE_BODY_MAX, "That is too long for a note"),
  color: z.enum(noteColorValues).default("YELLOW"),
  // Private by default. The cost of getting this wrong runs one way: a note meant for the writer
  // that lands on somebody else's board cannot be taken back.
  visibility: z.enum(noteVisibilityValues).default("PRIVATE"),
  pinned: z.boolean().default(false),
  /**
   * An ISO instant, or "" to clear it.
   *
   * Both update paths carry it because `updateNoteSchema` is a full replace: a pin toggle that
   * omitted this would silently cancel a reminder somebody had set, and they would find out by
   * not being reminded — the one failure a reminder cannot report.
   */
  remindAt: z.string().optional().or(z.literal("")),
  companyId: z.string().optional().or(z.literal("")),
  leadId: z.string().optional().or(z.literal("")),
  ticketId: z.string().optional().or(z.literal("")),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;

/**
 * No `companyId`/`leadId`/`ticketId` — the same shape as `updateTaskSchema`, and for the same
 * reason. What a note is stuck to is decided when it is written; allowing it to move afterwards
 * means the attachment check has to be re-run on every edit, and an edit that quietly re-points a
 * note at another account is the kind of change nobody reviews.
 */
export const updateNoteSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().max(NOTE_TITLE_MAX, "Keep the title short").optional().or(z.literal("")),
  body: z.string().trim().min(1, "A note needs something written in it").max(NOTE_BODY_MAX, "That is too long for a note"),
  color: z.enum(noteColorValues).default("YELLOW"),
  visibility: z.enum(noteVisibilityValues).default("PRIVATE"),
  pinned: z.boolean().default(false),
  /**
   * An ISO instant, or "" to clear it.
   *
   * Both update paths carry it because `updateNoteSchema` is a full replace: a pin toggle that
   * omitted this would silently cancel a reminder somebody had set, and they would find out by
   * not being reminded — the one failure a reminder cannot report.
   */
  remindAt: z.string().optional().or(z.literal("")),
});

export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

/** A board nobody could drag through. The cap is a ceiling on work, not a limit anybody will meet. */
export const REORDER_MAX = 500;

/**
 * The board sends the ids in the order they now appear. Positions are derived from the array index
 * rather than sent per note, so a drag cannot post a set of positions that disagree with itself.
 *
 * Capped, unlike the other bulk schemas in this directory, because reorder is the one that does not
 * collapse into a single statement: it fans out into one write per id inside a transaction, so the
 * array length is the caller choosing how long to hold a database transaction open. The others send
 * their whole list to one `updateMany` and cost the same whatever its length.
 */
export const reorderNotesSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, "Nothing to reorder").max(REORDER_MAX, "That is too many notes to reorder at once"),
});

export type ReorderNotesInput = z.infer<typeof reorderNotesSchema>;
