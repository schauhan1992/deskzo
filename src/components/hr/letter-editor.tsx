"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Printer, Undo2 } from "lucide-react";
import type { getLetter } from "@/actions/employee-docs";
import { issueLetter, revokeLetter, updateLetterBody } from "@/actions/employee-docs";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCalendarDay } from "@/lib/time/zone";
import { letterTypeLabels } from "@/lib/hr/letters";

type Letter = NonNullable<Awaited<ReturnType<typeof getLetter>>>;

/**
 * Reading a letter, and — while it is still a draft — changing the wording before it goes out.
 *
 * Editable on purpose. Every template needs a sentence adjusted for somebody, and a generator whose
 * output cannot be touched gets abandoned for a Word document within a month. What cannot be
 * changed is the *facts*: those were frozen when the letter was drafted, so editing the prose
 * cannot quietly restate the salary.
 */
export function LetterEditor({ letter, canManage }: { letter: Letter; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [body, setBody] = useState(letter.body);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const draft = letter.status === "DRAFT";
  const dirty = body !== letter.body;

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {/* A letter drafted for a candidate has no employee page to go back to yet. */}
          <Link
            href={letter.user ? `/people/${letter.user.id}` : "/people/hiring"}
            className="text-sm text-muted hover:text-text"
          >
            ← {letter.user?.name ?? "Hiring"}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold text-text">{letter.subject}</h1>
            <Badge tone={letter.status === "ISSUED" ? "green" : letter.status === "REVOKED" ? "red" : "amber"}>
              {letter.status}
            </Badge>
          </div>
          <p className="mt-0.5 font-mono text-xs text-subtle">
            {letter.letterNumber} · {letterTypeLabels[letter.type]} · {formatCalendarDay(letter.issuedOn)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/letters/${letter.id}/print`} target="_blank">
            <Button variant="secondary">
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              Print
            </Button>
          </Link>
          {canManage && draft && (
            <Button disabled={pending || dirty} onClick={() => run(() => issueLetter(letter.id))} title={dirty ? "Save your changes first" : undefined}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Issue
            </Button>
          )}
          {canManage && letter.status === "ISSUED" && (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => run(() => revokeLetter(letter.id))}
              title="The number stays on record as withdrawn"
            >
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              Revoke
            </Button>
          )}
        </div>
      </div>

      {!draft && (
        <Card className="border-line bg-surface-sunken px-4 py-2.5 text-xs text-muted">
          {letter.status === "ISSUED"
            ? "Issued — the wording is fixed now, because this number has already been quoted. Revoke it and draft another if it needs to change."
            : "Withdrawn. It still prints, stamped as invalid, because the reference number was given to somebody."}
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          <span>Body</span>
          {canManage && draft && (
            <span className="flex items-center gap-2">
              {saved && <span className="text-xs text-success">Saved.</span>}
              <Button
                size="sm"
                variant="secondary"
                disabled={pending || !dirty}
                onClick={() => run(() => updateLetterBody(letter.id, body), () => setSaved(true))}
              >
                {pending ? "Saving…" : "Save changes"}
              </Button>
            </span>
          )}
        </CardHeader>
        <CardContent>
          {canManage && draft ? (
            <textarea
              aria-label="Letter body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={26}
              className="w-full rounded-base border border-line-strong bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text"
            />
          ) : (
            <div className="whitespace-pre-wrap text-sm text-text">{letter.body}</div>
          )}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
