"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, ExternalLink, Mail, Phone, SkipForward } from "lucide-react";
import { completeRecord, openRecord, type myCallingQueue } from "@/actions/calling-activity";
import { verifyContactDetail } from "@/actions/verification";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { CallButton } from "@/components/calls/call-button";
import { EmailCheckBadge } from "@/components/contacts/email-address";
import { formatSpan } from "@/lib/workspace/allocation";
import { headcountLabel } from "@/lib/company-size";

type Queue = NonNullable<Awaited<ReturnType<typeof myCallingQueue>>>;
type Record_ = Queue["records"][number];
type Contact = Record_["company"]["contacts"][number];

/**
 * The calling screen: one record at a time, and only what's needed to make the call.
 *
 * Everything the 360 view shows — orders, invoices, documents, tabs — is noise to somebody working
 * through two hundred numbers. What's left is who to ring, on what number, a button to log it, and
 * a way to say the details were wrong. The record's own page is one click away for the rare case
 * that the context matters.
 */
export function CallingStation({ queue }: { queue: Queue }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const pendingRecords = queue.records.filter((r) => r.status === "PENDING" || r.status === "IN_PROGRESS");
  const [currentId, setCurrentId] = useState<string | null>(pendingRecords[0]?.id ?? null);
  const current = queue.records.find((r) => r.id === currentId) ?? null;

  function finish(recordId: string, status: "DONE" | "SKIPPED", note: string) {
    setError(null);
    startTransition(async () => {
      const result = await completeRecord({ recordId, status, note });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setCurrentId(result.data.nextId);
      router.refresh();
    });
  }

  const { progress } = queue;
  const percent = progress.total > 0 ? Math.round(((progress.total - progress.remaining) / progress.total) * 100) : 0;

  return (
    <div className="@container space-y-4">
      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <span className="text-lg font-semibold text-text">
                {progress.total - progress.remaining}
                <span className="text-sm font-normal text-muted"> of {progress.total}</span>
              </span>
              <span className="ml-3 text-sm text-muted">{progress.remaining} left</span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-xs text-subtle">
              <span>
                Avg call <span className="font-medium text-text">{formatSpan(progress.averageHandleSeconds)}</span>
              </span>
              <span>
                Avg gap <span className="font-medium text-text">{formatSpan(progress.averageGapSeconds)}</span>
              </span>
              <span>
                On the phone <span className="font-medium text-text">{formatSpan(progress.talkSeconds)}</span>
              </span>
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
          </div>
        </CardContent>
      </Card>

      {!current && (
        <Card className="px-4 py-16 text-center">
          <p className="text-lg font-medium text-text">That&apos;s the list.</p>
          <p className="mt-1 text-sm text-muted">
            Every record assigned to you has been worked. {progress.done} done in {formatSpan(progress.talkSeconds)} on
            the phone.
          </p>
          <Link href={`/workspace/${queue.workbook.id}`} className="mt-4 inline-block">
            <Button variant="secondary">Back to the list</Button>
          </Link>
        </Card>
      )}

      {current && (
        <>
          <Card>
            <CardHeader className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-semibold text-text">{current.company.name}</h2>
                  <Link
                    href={`/companies/${current.company.id}`}
                    target="_blank"
                    className="flex items-center gap-1 text-xs text-brand hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Full record
                  </Link>
                </div>
                <p className="mt-0.5 text-sm text-muted">
                  {[
                    current.company.industry?.name,
                    current.company.locations[0]
                      ? [current.company.locations[0].city, current.company.locations[0].state]
                          .filter(Boolean)
                          .join(", ")
                      : null,
                    headcountLabel(current.company.employeeCount) ? `${headcountLabel(current.company.employeeCount)} staff` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "No details on file"}
                </p>
              </div>
              <RecordClock recordId={current.id} />
            </CardHeader>

            <CardContent className="space-y-3">
              {current.company.contacts.length === 0 && (
                <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
                  No contacts on file for this company. Skip it, or open the full record to add one.
                </p>
              )}

              {current.company.contacts.map((contact) => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  companyId={current.company.id}
                  companyName={current.company.name}
                  recordId={current.id}
                />
              ))}
            </CardContent>
          </Card>

          <OutcomeForm
            key={current.id}
            pending={pending}
            error={error}
            remaining={Math.max(pendingRecords.length - 1, 0)}
            onFinish={(status, note) => finish(current.id, status, note)}
          />

          <details className="rounded-xl border border-line bg-surface px-4 py-3">
            <summary className="cursor-pointer text-sm text-muted">
              Coming up ({Math.max(pendingRecords.length - 1, 0)})
            </summary>
            <ul className="mt-2 space-y-1">
              {pendingRecords
                .filter((r) => r.id !== current.id)
                .slice(0, 12)
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setCurrentId(r.id)}
                      className="flex w-full items-center gap-2 rounded-base px-2 py-1 text-left text-sm text-text hover:bg-surface-sunken"
                    >
                      <ChevronRight className="h-3 w-3 text-subtle" />
                      {r.company.name}
                    </button>
                  </li>
                ))}
            </ul>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * One contact, with the two things a caller checks and a way to say they were wrong.
 *
 * Marking a detail wrong never edits the contact — it files what was found, and somebody reviews it
 * later. That's deliberate: a number corrected on a call is a claim, and this screen is the one
 * place in the app where people are typing fast under pressure.
 */
function ContactRow({
  contact,
  companyId,
  companyName,
  recordId,
}: {
  contact: Contact;
  companyId: string;
  companyName: string;
  recordId: string;
}) {
  return (
    <div className="rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium text-text">{contact.name}</span>
          <span className="ml-2 text-xs text-subtle">{contact.designation.replaceAll("_", " ").toLowerCase()}</span>
          {contact.isPrimary && (
            <Badge tone="blue" className="ml-2">
              Primary
            </Badge>
          )}
        </div>
        <CallButton
          companyId={companyId}
          companyName={companyName}
          contact={{ id: contact.id, name: contact.name, phone: contact.phone }}
          size="sm"
        />
      </div>

      <div className="mt-2 grid grid-cols-1 gap-2 @2xl:grid-cols-2">
        <DetailCheck
          icon={<Phone className="h-3.5 w-3.5" />}
          field="PHONE"
          value={contact.phone}
          companyId={companyId}
          contactId={contact.id}
          recordId={recordId}
        />
        <DetailCheck
          icon={<Mail className="h-3.5 w-3.5" />}
          field="EMAIL"
          value={contact.email}
          companyId={companyId}
          contactId={contact.id}
          recordId={recordId}
          known={<EmailCheckBadge contact={contact} />}
        />
      </div>
    </div>
  );
}

function DetailCheck({
  icon,
  field,
  value,
  companyId,
  contactId,
  recordId,
  /** What is already on record about this detail, shown before the caller asks about it. */
  known,
}: {
  icon: React.ReactNode;
  field: "EMAIL" | "PHONE";
  value: string | null;
  companyId: string;
  contactId: string;
  recordId: string;
  known?: React.ReactNode;
}) {
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "correcting" | "saved">("idle");
  const [corrected, setCorrected] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!value) {
    return (
      <div className="flex items-center gap-2 text-xs text-subtle">
        {icon}
        <span>No {field.toLowerCase()} on file</span>
      </div>
    );
  }

  function submit(status: "CORRECT" | "WRONG" | "CORRECTED") {
    setError(null);
    startTransition(async () => {
      const result = await verifyContactDetail({
        companyId,
        contactId,
        recordId,
        field,
        originalValue: value!,
        status,
        correctedValue: status === "CORRECTED" ? corrected : undefined,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setState("saved");
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-text">
          {icon}
          <span className="truncate font-mono text-xs">{value}</span>
          {known}
        </span>

        {state === "saved" ? (
          <Badge tone="green">Noted</Badge>
        ) : (
          <span className="flex items-center gap-1">
            <button
              type="button"
              disabled={pending}
              onClick={() => submit("CORRECT")}
              className="rounded-full px-2 py-0.5 text-xs text-success hover:bg-success-bg disabled:opacity-50"
            >
              Right
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setState("correcting")}
              className="rounded-full px-2 py-0.5 text-xs text-danger hover:bg-danger-bg disabled:opacity-50"
            >
              Wrong
            </button>
          </span>
        )}
      </div>

      {state === "correcting" && (
        <div className="space-y-1.5">
          <Input
            value={corrected}
            onChange={(e) => setCorrected(e.target.value)}
            placeholder={`Correct ${field.toLowerCase()}, if they gave you one`}
            className="h-8 text-xs"
            // Phone and email render this row side by side, so the field has to be in the name.
            aria-label={`Correct ${field.toLowerCase()}`}
          />
          <div className="flex gap-1.5">
            <Button size="sm" disabled={pending || !corrected.trim()} onClick={() => submit("CORRECTED")}>
              Save correction
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => submit("WRONG")}>
              Just wrong
            </Button>
          </div>
          <p className="text-xs text-subtle">
            The contact isn&apos;t changed — this is filed for review, with both values kept.
          </p>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}


/**
 * The stopwatch for the record on screen.
 *
 * Its own component, keyed by record id, so moving on remounts it at zero — and so the ticking
 * doesn't re-render the contact rows and their half-typed corrections every second.
 *
 * Opening the record here is what starts its clock server-side and closes the gap since the last
 * one, which is why it fires on mount rather than waiting for the caller to press anything.
 */
function RecordClock({ recordId }: { recordId: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    void openRecord(recordId);
  }, [recordId]);

  useEffect(() => {
    const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  return <Badge tone="blue">{formatSpan(elapsed)} on this one</Badge>;
}

/** Keyed by record id by its parent, so the note box empties itself between calls. */
function OutcomeForm({
  pending,
  error,
  remaining,
  onFinish,
}: {
  pending: boolean;
  error: string | null;
  remaining: number;
  onFinish: (status: "DONE" | "SKIPPED", note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="recordNote">How did it go?</Label>
          <Textarea
            id="recordNote"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Anything worth knowing before the next person rings them"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap gap-2">
          <Button disabled={pending} onClick={() => onFinish("DONE", note)}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Done — next
          </Button>
          <Button variant="secondary" disabled={pending} onClick={() => onFinish("SKIPPED", note)}>
            <SkipForward className="mr-1.5 h-3.5 w-3.5" />
            Skip
          </Button>
          <span className="ml-auto self-center text-xs text-subtle">{remaining} more after this</span>
        </div>
      </CardContent>
    </Card>
  );
}
