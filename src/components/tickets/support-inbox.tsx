"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Paperclip } from "lucide-react";
import { addEmailToTicket, createTicketFromEmail, ignoreSupportEmail } from "@/actions/support-mail";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { useClock } from "@/components/time/clock-provider";
import { fileSize } from "@/lib/support-mail/rules";
import { ticketPath } from "@/lib/record-links";

export type InboxEmail = {
  id: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  note: string | null;
  createdAt: string;
  attachments: { id: string; fileName: string; mimeType: string; sizeBytes: number }[];
  /** Companies where the sender is already a contact — offered first. */
  companies: { id: string; name: string }[];
};

/**
 * The Support inbox: emails to the helpdesk address that couldn't be placed by themselves — a sender who
 * isn't a contact yet, one who is a contact at several companies, a reply from somebody not on the
 * ticket it names (src/lib/support-mail/receive.ts). Each one is opened as a ticket at the company the
 * agent picks (saving the sender as a contact, so their next email files itself), added to a ticket they
 * name, or left out.
 */
export function SupportInbox({ emails, companies }: { emails: InboxEmail[]; companies: CompanyComboOption[] }) {
  if (emails.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-muted">Nothing waiting. Every email has found its ticket.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      {emails.map((email) => (
        <InboxCard key={email.id} email={email} companies={companies} />
      ))}
    </div>
  );
}

function InboxCard({ email, companies }: { email: InboxEmail; companies: CompanyComboOption[] }) {
  const router = useRouter();
  const clock = useClock();
  const [companyId, setCompanyId] = useState(email.companies.length === 1 ? email.companies[0]!.id : "");
  const [saveContact, setSaveContact] = useState(email.companies.length === 0);
  const [contactName, setContactName] = useState(email.fromName ?? "");
  const [ticketRef, setTicketRef] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; ticketSeq?: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const long = email.body.split("\n").length > 12 || email.body.length > 1200;
  const choices = [
    ...email.companies.map((c) => ({ id: c.id, name: c.name, hint: "(a contact there)" })),
    ...companies.filter((c) => !email.companies.some((k) => k.id === c.id)),
  ];

  function run(work: () => Promise<{ ok: true; data: { ticketSeq: number } | null } | { ok: false; error: string }>, text: (seq?: number) => string) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ text: text(result.data?.ticketSeq), ticketSeq: result.data?.ticketSeq });
      router.refresh();
    });
  }

  if (done) {
    return (
      <ActionNotice tone="success">
        {done.text}{" "}
        {done.ticketSeq && (
          <Link href={ticketPath(done.ticketSeq)} className="font-medium underline">
            Open it
          </Link>
        )}
      </ActionNotice>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-text">{email.subject}</p>
            <p className="truncate text-xs text-muted">
              {email.fromName ? `${email.fromName} · ` : ""}
              {email.fromAddress} · {clock.dateTime(email.createdAt)}
            </p>
          </div>
          {email.note && <Badge tone="amber">{email.note}</Badge>}
        </div>

        <div className={`relative whitespace-pre-wrap break-words rounded-base bg-surface-sunken px-3 py-2 text-sm text-text ${long && !expanded ? "max-h-48 overflow-hidden" : ""}`}>
          {email.body || <span className="text-subtle">(No text.)</span>}
        </div>
        {long && (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="text-xs text-muted underline decoration-dotted hover:text-text">
            {expanded ? "Show less" : "Show the whole email"}
          </button>
        )}

        {email.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {email.attachments.map((a) => (
              <li key={a.id}>
                <a
                  href={`/api/support-email/attachments/${a.id}`}
                  className="inline-flex items-center gap-1 rounded-base border border-line px-2 py-1 text-xs text-text hover:bg-surface-sunken"
                >
                  <Paperclip className="h-3 w-3" aria-hidden="true" />
                  {a.fileName} <span className="text-subtle">({fileSize(a.sizeBytes)})</span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-4 border-t border-line pt-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`company-${email.id}`}>Open a ticket at</Label>
            <CompanyCombobox id={`company-${email.id}`} companies={choices} value={companyId} onSelect={(c) => setCompanyId(c?.id ?? "")} />
            <label className="flex items-start gap-2 text-sm text-text">
              <input type="checkbox" checked={saveContact} onChange={(e) => setSaveContact(e.target.checked)} className="mt-0.5 h-4 w-4" />
              <span>
                Save {email.fromAddress} as a contact there
                <span className="block text-xs text-subtle">Their next email then opens its own ticket.</span>
              </span>
            </label>
            {saveContact && (
              <Input aria-label="Contact name" placeholder="Their name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            )}
            <Button
              type="button"
              size="sm"
              disabled={!companyId || pending}
              onClick={() =>
                run(
                  () => createTicketFromEmail({ emailId: email.id, companyId, saveContact, contactName }),
                  (seq) => `Ticket TCK-${String(seq ?? 0).padStart(6, "0")} opened.`,
                )
              }
            >
              {pending ? "Working…" : "Open ticket"}
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor={`ticket-${email.id}`}>Or add it to a ticket</Label>
            <Input id={`ticket-${email.id}`} placeholder="TCK-001234" value={ticketRef} onChange={(e) => setTicketRef(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!ticketRef.trim() || pending}
                onClick={() => run(() => addEmailToTicket({ emailId: email.id, ticket: ticketRef }), (seq) => `Added to TCK-${String(seq ?? 0).padStart(6, "0")}.`)}
              >
                Add to ticket
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => ignoreSupportEmail(email.id), () => "Left out.")}>
                Leave out
              </Button>
            </div>
          </div>
        </div>

        {error && <ActionNotice tone="error">{error}</ActionNotice>}
      </CardContent>
    </Card>
  );
}
