"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, MessageSquareText, Phone, StickyNote } from "lucide-react";
import { saveCardContactNote } from "@/actions/card";
import { useClock } from "@/components/time/clock-provider";
import type { CardContactRow } from "@/lib/cards/views";
import { Badge, Card } from "@/components/ui/card";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Everybody who shared their details back from a card: the holder's own on My card, everyone's for a
 * card manager. A note each, and the lead it became when the CRM made one.
 *
 * One or two lines a person (owner, 15 Oct 2026 — a card each took a screen for three people): who and
 * how to reach them, then which card and the note. What they wrote is behind a speech bubble that opens
 * on hover, focus or a tap, as a renewal's remark is; the note behind its own icon, which edits it.
 */
export function CardContactsList({ rows, showHolder, empty }: { rows: CardContactRow[]; showHolder: boolean; empty: string }) {
  if (rows.length === 0) return <Card className="px-6 py-10 text-center text-sm text-muted">{empty}</Card>;
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
      {rows.map((row) => (
        <ContactRow key={row.id} row={row} showHolder={showHolder} />
      ))}
    </ul>
  );
}

function ContactRow({ row, showHolder }: { row: CardContactRow; showHolder: boolean }) {
  const clock = useClock();
  const [editing, setEditing] = useState(false);
  const who = [row.jobTitle, row.company].filter(Boolean).join(" · ");
  const said = [...row.answers.map((a) => `${a.label}: ${a.answer}`), row.message].filter(Boolean).join("\n");
  const source =
    showHolder || row.via !== "SHARE_BACK"
      ? `${row.via === "SCAN" ? `Scanned by ${row.holder}` : row.via === "BOOTH" ? `Booth form on ${row.holder}'s card` : `From ${row.holder}'s card`}${row.owner !== row.holder ? ` · now with ${row.owner}` : ""}`
      : null;

  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-0.5 text-sm">
          <p className="min-w-0 max-w-full truncate">
            <span className="font-semibold text-text">{row.name}</span>
            {who && <span className="text-muted"> · {who}</span>}
          </p>
          {row.email && (
            <a href={`mailto:${row.email}`} className="inline-flex min-w-0 items-center gap-1.5 text-brand hover:underline">
              <Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{row.email}</span>
            </a>
          )}
          {row.phone && (
            <a href={`tel:${row.phone.replace(/[^0-9+]/g, "")}`} className="inline-flex items-center gap-1.5 whitespace-nowrap text-brand hover:underline">
              <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {row.phone}
            </a>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-subtle">
          {row.event && <Badge tone="blue">{row.event}</Badge>}
          {said && (
            <HoverText label={`What ${row.name} wrote`} text={said}>
              <MessageSquareText aria-hidden className="h-3.5 w-3.5" />
            </HoverText>
          )}
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label={row.note ? "Edit note" : "Add a note"}
            title={row.note ? "Edit note" : "Add a note"}
            className={cn(
              "inline-flex h-5 w-5 items-center justify-center rounded hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand",
              row.note ? "text-brand" : "text-subtle",
            )}
          >
            <StickyNote aria-hidden className="h-3.5 w-3.5" />
          </button>
          {row.leadLink ? (
            <Link href={row.leadLink} className="whitespace-nowrap text-brand hover:underline">
              Open the lead
            </Link>
          ) : (
            row.leadsHere && <Badge>No lead</Badge>
          )}
          <span className="whitespace-nowrap">{clock.dateTimeShort(row.createdAt)}</span>
        </div>
      </div>
      {(source || (row.note && !editing)) && (
        <p className="mt-0.5 truncate text-xs text-subtle">
          {source}
          {source && row.note && !editing ? " · " : ""}
          {row.note && !editing && (
            <span className="text-text" title={row.note}>
              Note: {row.note}
            </span>
          )}
        </p>
      )}
      {editing && <NoteEditor id={row.id} note={row.note} onDone={() => setEditing(false)} />}
    </li>
  );
}

/** A small icon that shows a longer text on hover, keyboard focus or a tap (a phone has no hover). */
function HoverText({ label, text, children }: { label: string; text: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-brand hover:text-text focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        {children}
      </button>
      <AnchoredPopover anchorRef={ref} open={open} width={300} align="end">
        <div id={id} role="tooltip" className="space-y-1 p-2.5">
          <p className="text-[11px] text-subtle">{label}</p>
          <p className="whitespace-pre-line text-sm text-text">{text}</p>
        </div>
      </AnchoredPopover>
    </>
  );
}

function NoteEditor({ id, note, onDone }: { id: string; note: string | null; onDone: () => void }) {
  const router = useRouter();
  const [value, setValue] = useState(note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="mt-2 space-y-2">
      <Textarea rows={2} maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Note" autoFocus />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await saveCardContactNote(id, value);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              onDone();
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : "Save note"}
        </Button>
      </div>
    </div>
  );
}
