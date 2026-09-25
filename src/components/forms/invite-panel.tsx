"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BellRing, Check, Mail, Search, UserPlus, X } from "lucide-react";
import { previewInvites, searchInvitees, sendFormInvites } from "@/actions/forms";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { cn } from "@/lib/utils";

type Found = NonNullable<Awaited<ReturnType<typeof searchInvitees>>>[number];
type Checked = Extract<Awaited<ReturnType<typeof previewInvites>>, { ok: true }>["people"][number];
type Picked = { id: string; name: string; company: string };

/**
 * Inviting customers to a form, or reminding the ones who haven't answered.
 *
 * Three steps, because the middle one is the point: pick people, then see — before anything goes —
 * who cannot be reached and why ("bounced last month", "a reseller's customer"), then send. The
 * message is editable, but it must keep {{formLink}}: that is each person's own link, and an
 * invitation without it is a letter nobody can answer.
 */
export function InvitePanel({
  formId,
  defaultSubject,
  defaultBody,
  waiting,
}: {
  formId: string;
  defaultSubject: string;
  defaultBody: string;
  /** Invited, not withdrawn, not answered — the people a reminder is for. */
  waiting: Picked[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"pick" | "check" | "done">("pick");
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [checked, setChecked] = useState<Checked[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  // Searched as they type, a moment after they stop.
  useEffect(() => {
    if (!open || query.trim().length < 2) return;
    const timer = setTimeout(async () => {
      setFound((await searchInvitees(formId, query)) ?? []);
    }, 250);
    return () => clearTimeout(timer);
  }, [formId, open, query]);

  const reset = () => {
    setStep("pick");
    setPicked([]);
    setChecked([]);
    setError(null);
    setOutcome(null);
    setQuery("");
    setFound([]);
  };

  const toggle = (person: Picked) =>
    setPicked((all) => (all.some((p) => p.id === person.id) ? all.filter((p) => p.id !== person.id) : [...all, person]));

  const check = () => {
    setError(null);
    startTransition(async () => {
      const result = await previewInvites(formId, picked.map((p) => p.id));
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setChecked(result.people);
      setStep("check");
    });
  };

  const send = () => {
    setError(null);
    startTransition(async () => {
      const reachable = checked.filter((c) => c.canReceive).map((c) => c.id);
      const result = await sendFormInvites(formId, { contactIds: reachable, subject, body });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { queued, sent, skipped } = result.data;
      setOutcome(
        `${queued} ${queued === 1 ? "invitation" : "invitations"} queued, ${sent} sent now.` +
          (queued > sent ? " The rest go out with the next send run." : "") +
          (skipped.length ? ` ${skipped.length} skipped: ${skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}` : ""),
      );
      setStep("done");
      router.refresh();
    });
  };

  const reachable = checked.filter((c) => c.canReceive);

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          <UserPlus className="h-3.5 w-3.5" />
          Invite people
        </Button>
        {waiting.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              reset();
              setPicked(waiting);
              setOpen(true);
            }}
          >
            <BellRing className="h-3.5 w-3.5" />
            Remind {waiting.length} who haven&apos;t answered
          </Button>
        )}
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title={step === "check" ? "Check before sending" : step === "done" ? "Sent" : "Invite people"}>
        {step === "pick" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="inv-search">Find people</Label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-subtle" aria-hidden />
                <Input
                  id="inv-search"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="A name, an address, or a company"
                  autoComplete="off"
                />
              </div>
              <p className="text-xs text-subtle">Contacts on the accounts you can see, with an email address.</p>
            </div>

            {query.trim().length >= 2 && (
              <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
                {found.length === 0 ? (
                  <p className="px-3 py-4 text-center text-xs text-subtle">Nobody matches that.</p>
                ) : (
                  found.map((person) => {
                    const on = picked.some((p) => p.id === person.id);
                    return (
                      <button
                        key={person.id}
                        type="button"
                        onClick={() => toggle({ id: person.id, name: person.name, company: person.company.name })}
                        className={cn(
                          "flex w-full items-start justify-between gap-2 border-b border-line px-3 py-2 text-left last:border-0",
                          on ? "bg-brand-subtle/60" : "hover:bg-surface-sunken",
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block text-sm text-text">
                            {person.name}
                            {person.designation && <span className="text-muted"> · {person.designation}</span>}
                          </span>
                          <span className="block truncate text-xs text-muted">
                            {person.company.name} · {person.email}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1.5">
                          {person.invited && (
                            <Badge tone={person.invited === "answered" ? "green" : "default"}>
                              {person.invited === "answered" ? "Answered" : person.invited === "withdrawn" ? "Withdrawn" : "Invited"}
                            </Badge>
                          )}
                          {on && <Check className="h-4 w-4 text-brand" aria-label="Selected" />}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            )}

            {picked.length > 0 && (
              <div className="space-y-1.5">
                <div className="text-xs font-medium text-muted">{picked.length} selected</div>
                <div className="flex flex-wrap gap-1.5">
                  {picked.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs text-text">
                      {p.name}
                      <span className="text-subtle">· {p.company}</span>
                      <button type="button" aria-label={`Remove ${p.name}`} onClick={() => toggle(p)} className="text-subtle hover:text-text">
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="inv-subject">Subject</Label>
              <Input id="inv-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="inv-body">Message</Label>
              <Textarea id="inv-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} className="font-mono text-xs" />
              <p className="text-xs text-subtle">
                <span className="font-mono">{"{{formLink}}"}</span> becomes each person&apos;s own link — keep it in.{" "}
                <span className="font-mono">{"{{firstName|there}}"}</span>, <span className="font-mono">{"{{companyName}}"}</span>,{" "}
                <span className="font-mono">{"{{eventDate}}"}</span> and <span className="font-mono">{"{{eventVenue}}"}</span> are filled
                in per person. Sent from you, one person at a time, and logged in the Mail log.
              </p>
            </div>

            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={check} disabled={pending || picked.length === 0}>
                {pending ? "Checking…" : `Check ${picked.length || ""}`.trim()}
              </Button>
            </div>
          </div>
        )}

        {step === "check" && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              {reachable.length} of {checked.length} can be sent to.
              {checked.length > reachable.length && " The others are listed with the reason — nothing goes to them."}
            </p>
            <div className="max-h-72 overflow-y-auto rounded-lg border border-line">
              {checked.map((person) => (
                <div key={person.id} className="flex items-start justify-between gap-2 border-b border-line px-3 py-2 last:border-0">
                  <span className="min-w-0">
                    <span className="block text-sm text-text">{person.name}</span>
                    <span className="block truncate text-xs text-muted">
                      {person.company.name} · {person.email ?? "no address"}
                    </span>
                  </span>
                  {person.canReceive ? (
                    <Badge tone={person.reminder ? "blue" : "green"}>
                      <Mail className="h-3 w-3" aria-hidden />
                      {person.reminder ? "Reminder" : "Invitation"}
                    </Badge>
                  ) : (
                    <span className="max-w-[55%] text-right text-xs text-warning">{person.blockedBecause}</span>
                  )}
                </div>
              ))}
            </div>
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setStep("pick")} disabled={pending}>
                Back
              </Button>
              <Button onClick={send} disabled={pending || reachable.length === 0}>
                {pending ? "Sending…" : `Send to ${reachable.length}`}
              </Button>
            </div>
          </div>
        )}

        {step === "done" && (
          <div className="space-y-4">
            {outcome && <ActionNotice tone="success">{outcome}</ActionNotice>}
            <div className="flex justify-end">
              <Button onClick={() => setOpen(false)}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
