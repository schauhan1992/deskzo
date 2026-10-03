import Link from "next/link";
import { Archive, Bell, ArchiveRestore, Building2, Globe, Pencil, Pin, PinOff, Target, Ticket, Trash2, Users } from "lucide-react";
import type { NoteListItem } from "@/actions/note";
import type { NoteColor } from "@/lib/validation/note";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Badge } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { cn } from "@/lib/utils";
import { formatTicketId } from "@/lib/tickets";
import { companyPath, leadPath, ticketPath } from "@/lib/record-links";
import type { Clock } from "@/lib/time/zone";

/**
 * The sticky-note palette, defined once here and reused by the dialog's swatches.
 *
 * Each colour is a hue mixed into `--surface` rather than a fixed pastel, because the board has to
 * work in both themes and this file cannot reach the theme. A literal `#fef08a` is a pleasant sticky
 * note on white and an eye-watering slab on the dark background; mixing the same hue into whatever
 * `--surface` currently is gives a pale tint in light mode and a deep tint in dark, and `text-text`
 * stays readable on both without a second set of classes. The `dark:` variant is not an option —
 * this app switches theme with a `.dark` class on the root and Tailwind's `dark:` here would follow
 * the OS instead, so anyone overriding their system theme would get the wrong notes.
 *
 * 20% is the point where the seven are still distinguishable from each other and from the board
 * behind them. Grey is the deliberate exception in spirit — it is the "no colour" note, and it reads
 * as one because slate barely shifts the surface.
 */
export const noteColorClasses: Record<NoteColor, string> = {
  YELLOW: "bg-[color-mix(in_srgb,#eab308_20%,var(--surface))] border-[color-mix(in_srgb,#eab308_55%,var(--line))]",
  GREEN: "bg-[color-mix(in_srgb,#22c55e_20%,var(--surface))] border-[color-mix(in_srgb,#22c55e_55%,var(--line))]",
  BLUE: "bg-[color-mix(in_srgb,#3b82f6_20%,var(--surface))] border-[color-mix(in_srgb,#3b82f6_55%,var(--line))]",
  PINK: "bg-[color-mix(in_srgb,#ec4899_20%,var(--surface))] border-[color-mix(in_srgb,#ec4899_55%,var(--line))]",
  PURPLE: "bg-[color-mix(in_srgb,#a855f7_20%,var(--surface))] border-[color-mix(in_srgb,#a855f7_55%,var(--line))]",
  ORANGE: "bg-[color-mix(in_srgb,#f97316_20%,var(--surface))] border-[color-mix(in_srgb,#f97316_55%,var(--line))]",
  GREY: "bg-[color-mix(in_srgb,#64748b_20%,var(--surface))] border-[color-mix(in_srgb,#64748b_55%,var(--line))]",
};

/** "YELLOW" is not something to show a person. Used for swatch labels and the colour filter. */
export function noteColorLabel(color: NoteColor): string {
  return color.charAt(0) + color.slice(1).toLowerCase();
}

/**
 * Who else can see this, as a badge — and nothing at all for a private note.
 *
 * Silence is the right signal for PRIVATE: it is the default and by far the common case, and a
 * "Just me" badge on every card would train people to stop reading the row that matters.
 */
function VisibilityBadge({ note }: { note: NoteListItem }) {
  if (note.visibility === "TEAM") {
    return (
      <Badge tone="blue">
        <Users className="h-3 w-3" />
        Team
      </Badge>
    );
  }
  if (note.visibility === "EVERYONE") {
    return (
      <Badge tone="amber">
        <Globe className="h-3 w-3" />
        Everyone
      </Badge>
    );
  }
  return null;
}

/** The record the note is stuck to, if any. A note on an account should get you to the account. */
function AttachedRecord({ note }: { note: NoteListItem }) {
  if (note.company) {
    return (
      <Link href={companyPath(note.company.companySeq)} className="inline-flex items-center gap-1 hover:underline">
        <Building2 className="h-3 w-3 shrink-0" />
        <span className="truncate">{note.company.name}</span>
      </Link>
    );
  }
  if (note.lead) {
    return (
      <Link href={leadPath(note.lead.leadSeq)} className="inline-flex items-center gap-1 hover:underline">
        <Target className="h-3 w-3 shrink-0" />
        <span className="truncate">{note.lead.title}</span>
      </Link>
    );
  }
  if (note.ticket) {
    return (
      <Link href={ticketPath(note.ticket.ticketSeq)} className="inline-flex items-center gap-1 hover:underline">
        <Ticket className="h-3 w-3 shrink-0" />
        <span className="truncate">{formatTicketId(note.ticket.ticketSeq)}</span>
      </Link>
    );
  }
  return null;
}

/**
 * One sticky note.
 *
 * Every control is gated on `note.canEdit`, which the server sets to "you own this" and is the only
 * thing the board is allowed to decide edit rights from. A note you can see but not own renders as
 * something to read, with its author's name on it so you know who to ask.
 */
/**
 * When a note is coming back, or that it already has.
 *
 * A reminder whose moment has passed keeps its badge rather than disappearing, and says so. The
 * notification has already been sent by then, so hiding it here would leave the board looking
 * exactly like a board with no reminders on it — which is the state somebody checks when they are
 * wondering whether they set one at all.
 */
function formatReminder(at: Date, clock: Clock): string {
  const time = clock.time(at);
  if (clock.dateKey(at) === clock.today()) return time;
  return `${clock.dayMonth(at)}, ${time}`;
}

function ReminderBadge({ remindAt, due }: { remindAt: Date | null; due: boolean }) {
  const clock = useClock();
  if (!remindAt) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px]",
        due ? "bg-warning-bg text-warning" : "text-muted",
      )}
      title={clock.dateTime(remindAt)}
    >
      <Bell className="h-3 w-3 shrink-0" />
      {due ? "Due" : formatReminder(remindAt, clock)}
    </span>
  );
}

export function NoteCard({
  note,
  onEdit,
  onTogglePin,
  onArchive,
  onDelete,
  busy = false,
  className,
}: {
  note: NoteListItem;
  onEdit?: (note: NoteListItem) => void;
  onTogglePin?: (note: NoteListItem) => void;
  onArchive?: (note: NoteListItem) => void;
  onDelete?: (note: NoteListItem) => void;
  busy?: boolean;
  className?: string;
}) {
  const clock = useClock();
  const archived = note.archivedAt !== null;
  const attached = note.company ?? note.lead ?? note.ticket;

  return (
    <article
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3.5 shadow-sm transition-shadow duration-200 hover:shadow-md",
        noteColorClasses[note.color],
        // An archived note is still on screen when the toggle is on, so it has to read as filed away
        // rather than as one more note competing for attention.
        archived && "opacity-60",
        busy && "pointer-events-none opacity-50",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {note.title && <h3 className="truncate text-sm font-semibold text-text">{note.title}</h3>}
          <div className="flex flex-wrap items-center gap-1.5">
            {note.pinned && <Pin className="h-3 w-3 shrink-0 text-muted" />}
            <VisibilityBadge note={note} />
            <ReminderBadge remindAt={note.remindAt} due={note.remindDue} />
            {archived && <Badge>Archived</Badge>}
          </div>
        </div>

        {note.canEdit && (
          <RowActions className="shrink-0">
            {onTogglePin && (
              <IconButton
                icon={note.pinned ? PinOff : Pin}
                label={note.pinned ? "Unpin note" : "Pin note"}
                onClick={() => onTogglePin(note)}
              />
            )}
            {onEdit && <IconButton icon={Pencil} label="Edit note" onClick={() => onEdit(note)} />}
            {onArchive && (
              <IconButton
                icon={archived ? ArchiveRestore : Archive}
                label={archived ? "Restore note" : "Archive note"}
                onClick={() => onArchive(note)}
              />
            )}
            {onDelete && <IconButton icon={Trash2} label="Delete note" tone="danger" onClick={() => onDelete(note)} />}
          </RowActions>
        )}
      </div>

      {/* A note is written with its line breaks meaning something — a list of three things is three
          lines, and reflowing it into a paragraph loses the list. */}
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-text">{note.body}</p>

      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-xs text-muted">
        {attached && <AttachedRecord note={note} />}
        {attached && <span aria-hidden className="text-subtle">·</span>}
        {/* Only on somebody else's note. On your own board the answer is always "you". */}
        {!note.canEdit && (
          <>
            <span className="truncate font-medium">{note.ownerName}</span>
            <span aria-hidden className="text-subtle">·</span>
          </>
        )}
        <span>{clock.date(note.updatedAt)}</span>
      </div>
    </article>
  );
}
