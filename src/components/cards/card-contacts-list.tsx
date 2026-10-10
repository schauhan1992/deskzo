"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Mail, Phone } from "lucide-react";
import { saveCardContactNote } from "@/actions/card";
import { useClock } from "@/components/time/clock-provider";
import type { CardContactRow } from "@/lib/cards/views";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";

/**
 * Everybody who shared their details back from a card: the holder's own on My card, everyone's for a
 * card manager. A note each, and the lead it became when the CRM made one.
 */
export function CardContactsList({ rows, showHolder, empty }: { rows: CardContactRow[]; showHolder: boolean; empty: string }) {
  const clock = useClock();
  if (rows.length === 0) return <Card className="px-6 py-10 text-center text-sm text-muted">{empty}</Card>;
  return (
    <ul className="space-y-3">
      {rows.map((row) => (
        <li key={row.id} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-text">{row.name}</p>
              <p className="text-xs text-muted">{[row.jobTitle, row.company].filter(Boolean).join(" · ") || "—"}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
              {row.leadLink ? (
                <Link href={row.leadLink} className="text-brand hover:underline">
                  Open the lead
                </Link>
              ) : (
                <Badge>No lead</Badge>
              )}
              <span>{clock.dateTimeShort(row.createdAt)}</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {row.email && (
              <a href={`mailto:${row.email}`} className="inline-flex items-center gap-1.5 text-brand">
                <Mail className="h-3.5 w-3.5" aria-hidden />
                {row.email}
              </a>
            )}
            {row.phone && (
              <a href={`tel:${row.phone.replace(/[^0-9+]/g, "")}`} className="inline-flex items-center gap-1.5 text-brand">
                <Phone className="h-3.5 w-3.5" aria-hidden />
                {row.phone}
              </a>
            )}
          </div>
          {(row.message || row.answers.length > 0) && (
            <div className="mt-2 space-y-1 rounded-base bg-surface-sunken px-3 py-2 text-sm text-text">
              {row.answers.map((a) => (
                <p key={a.label}>
                  <span className="text-muted">{a.label}:</span> {a.answer}
                </p>
              ))}
              {row.message && <p className="whitespace-pre-wrap">{row.message}</p>}
            </div>
          )}
          {showHolder && (
            <p className="mt-2 text-xs text-subtle">
              From {row.holder}&apos;s card{row.owner !== row.holder ? ` · now with ${row.owner}` : ""}
            </p>
          )}
          <NoteField id={row.id} note={row.note} />
        </li>
      ))}
    </ul>
  );
}

function NoteField({ id, note }: { id: string; note: string | null }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!editing) {
    return (
      <div className="mt-2 flex items-start gap-2 text-sm">
        {note ? <p className="flex-1 whitespace-pre-wrap text-text">{note}</p> : <p className="flex-1 text-subtle">No note.</p>}
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
          {note ? "Edit note" : "Add a note"}
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      <Textarea rows={2} maxLength={2000} value={value} onChange={(e) => setValue(e.target.value)} aria-label="Note" />
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={pending}>
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
              setEditing(false);
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
