"use client";

import { useId, useState, useSyncExternalStore, type FormEvent } from "react";
import { Check, LoaderCircle, NotebookPen, X } from "lucide-react";
import { consoleDecideDeal, consoleDecideRequest, consoleUpdateApplication } from "@/actions/platform/console-partners";
import { ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { dayMonthYear } from "@/lib/console-shared/format";
import { PARTNER_APPLICATION_STATUS } from "@/lib/console-shared/labels";
import type { PartnerApplicationStatus, TermsInput } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { slugProblem } from "./format";
import { TermsFields, draftFromTerms, termsFromDraft, termsProblem, type TermsDraft } from "./terms-fields";

/**
 * The decisions staff make on what partners and applicants send (spec §4.3, §8.9, §9.2): deal
 * registrations (SELLERS), profile and payout changes (MANAGERS and PAYERS by kind), new resellers
 * (MANAGERS: the approval asks the reseller's console address and first terms, then invites its
 * proposed contact as ADMIN), and applications (MANAGERS: status and notes). The page draws each
 * control only for the roles its action allows; every action checks again. Notes to partners are
 * optional and shown to them.
 */

const noSubscribe = () => () => {};
const NOTE = { label: "Note to the partner (optional, shown to them)", minLength: 0, maxLength: 500 };

// ─── Deals ───────────────────────────────────────────────────────────────────────────────────────

export function DealDecisionButtons({ deal }: { deal: { id: string; companyName: string; domain: string; partnerName: string } }) {
  const action = useConsoleAction<{ status: string; expiresAt: Date | null }>();
  const [open, setOpen] = useState<"APPROVE" | "DECLINE" | null>(null);

  function ask(decision: "APPROVE" | "DECLINE") {
    action.reset();
    setOpen(decision);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(null);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Button type="button" size="sm" variant="secondary" onClick={() => ask("APPROVE")} aria-label={`Approve ${deal.companyName}'s registration`}>
        <Check aria-hidden="true" className="h-4 w-4" />
        Approve
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => ask("DECLINE")} aria-label={`Decline ${deal.companyName}'s registration`}>
        <X aria-hidden="true" className="h-4 w-4" />
        Decline
      </Button>
      <ConfirmDialog
        open={open !== null}
        onClose={close}
        title={open === "DECLINE" ? "Decline deal registration" : "Approve deal registration"}
        confirmLabel={open === "DECLINE" ? "Decline" : "Approve"}
        tone={open === "DECLINE" ? "danger" : "primary"}
        reason={NOTE}
        pending={action.pending}
        error={action.error}
        onConfirm={({ reason }) => {
          const decision = open ?? "APPROVE";
          action.run(() => consoleDecideDeal(deal.id, decision, reason || null), {
            success: (d) => (decision === "APPROVE" ? `Deal registration approved — ${deal.domain} is ${deal.partnerName}'s until ${dayMonthYear(d.expiresAt)}.` : "Deal registration declined."),
            onDone: () => setOpen(null),
          });
        }}
      >
        <p>
          {open === "DECLINE"
            ? `${deal.companyName} (${deal.domain}) stays open to any partner, or none. ${deal.partnerName} is told.`
            : `A signup from ${deal.domain} is attributed to ${deal.partnerName} while the protection lasts — ahead of any invitation code. ${deal.partnerName} is told.`}
        </p>
      </ConfirmDialog>
    </span>
  );
}

// ─── Profile, payout and reseller requests ───────────────────────────────────────────────────────

/** Approve (when `canApprove`) and Reject, each asking an optional note for the partner. */
export function RequestDecisionButtons({ request, canApprove = true }: { request: { id: string; subject: string; partnerName: string }; canApprove?: boolean }) {
  const action = useConsoleAction<unknown>();
  const [open, setOpen] = useState<"APPROVE" | "REJECT" | null>(null);

  function ask(decision: "APPROVE" | "REJECT") {
    action.reset();
    setOpen(decision);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(null);
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {canApprove && (
        <Button type="button" size="sm" variant="secondary" onClick={() => ask("APPROVE")} aria-label={`Approve ${request.partnerName}'s ${request.subject.toLowerCase()}`}>
          <Check aria-hidden="true" className="h-4 w-4" />
          Approve
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={() => ask("REJECT")} aria-label={`Reject ${request.partnerName}'s ${request.subject.toLowerCase()}`}>
        <X aria-hidden="true" className="h-4 w-4" />
        Reject
      </Button>
      <ConfirmDialog
        open={open !== null}
        onClose={close}
        title={open === "REJECT" ? `Reject the ${request.subject.toLowerCase()}` : `Approve the ${request.subject.toLowerCase()}`}
        confirmLabel={open === "REJECT" ? "Reject" : "Approve"}
        tone={open === "REJECT" ? "danger" : "primary"}
        reason={NOTE}
        pending={action.pending}
        error={action.error}
        onConfirm={({ reason }) => {
          const decision = open ?? "APPROVE";
          action.run(() => consoleDecideRequest(request.id, decision, reason || null), {
            success: decision === "APPROVE" ? "Request approved." : "Request rejected.",
            onDone: () => setOpen(null),
          });
        }}
      >
        <p>
          {open === "REJECT"
            ? `Nothing on file changes. ${request.partnerName}'s admins are told.`
            : `What ${request.partnerName} asked for replaces what is on file now. Its admins are told.`}
        </p>
      </ConfirmDialog>
    </span>
  );
}

type ResellerSeed = { id: string; displayName: string; distributorName: string; suggestedSlug: string; contactEmail: string };
type Decided = { resultPartner: { slug: string } | null; invite: { setupUrl: string; emailed: boolean } | { error: string } | null };

/** Approving a new reseller: its console address and first terms, then its proposed contact is invited as ADMIN. */
export function ResellerApproveButton({ request, plans, defaults, todayKey }: { request: ResellerSeed; plans: { key: string; name: string }[]; defaults: TermsInput; todayKey: string }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<Decided>();
  const [open, setOpen] = useState(false);

  function ask(on: boolean) {
    action.reset();
    setOpen(on);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => ask(true)} aria-label={`Approve ${request.displayName} as a reseller`}>
        <Check aria-hidden="true" className="h-4 w-4" />
        Approve
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Approve ${request.displayName}`} wide>
        <ResellerForm request={request} plans={plans} defaults={defaults} todayKey={todayKey} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function ResellerForm({
  request,
  plans,
  defaults,
  todayKey,
  action,
  onClose,
}: {
  request: ResellerSeed;
  plans: { key: string; name: string }[];
  defaults: TermsInput;
  todayKey: string;
  action: ReturnType<typeof useConsoleAction<Decided>>;
  onClose: () => void;
}) {
  const id = useId();
  const [slug, setSlug] = useState(request.suggestedSlug);
  const [terms, setTerms] = useState<TermsDraft>(() => draftFromTerms(defaults));
  const [note, setNote] = useState("");
  const [done, setDone] = useState<Decided | null>(null);

  if (done) {
    const invite = done.invite;
    return (
      <div className="space-y-4">
        <p className="text-sm text-text">{`${request.displayName} is a reseller under ${request.distributorName} now, onboarding.`}</p>
        {invite && "setupUrl" in invite ? (
          <OnceSecret
            label={`Set-password link for ${request.contactEmail}`}
            value={invite.setupUrl}
            copyLabel="Copy link"
            note={invite.emailed ? "Emailed to them. Shown once here in case the mail does not arrive." : "The email could not be sent — pass this link on yourself. Shown once."}
            onDone={onClose}
          />
        ) : (
          <>
            <p className="rounded-lg border border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
              {`Its admin couldn't be invited${invite && "error" in invite ? `: ${invite.error}` : "."} Invite one from its page.`}
            </p>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}
      </div>
    );
  }

  const slugId = `${id}-slug`;
  const slugHint = `${id}-slug-hint`;
  const noteId = `${id}-note`;
  const slugBad = slugProblem(slug);
  const problem = (slugBad ? `Address: ${slugBad}` : null) ?? termsProblem(terms, "RESELLER", todayKey);
  const ready = problem === null && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleDecideRequest(request.id, "APPROVE", note.trim() || null, { slug: slug.trim().toLowerCase(), terms: termsFromDraft(terms, "RESELLER") }), {
      success: `Reseller created — ${request.displayName}.`,
      onDone: (d) => setDone(d),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-4">
          <p className="text-sm text-text">{`Creates ${request.displayName} as a reseller under ${request.distributorName}, from what the distributor proposed, and invites ${request.contactEmail} as its admin.`}</p>
          <div className="space-y-1.5">
            <Label htmlFor={slugId}>Console address</Label>
            <Input
              id={slugId}
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!slugBad || undefined}
              aria-describedby={slugHint}
              readOnly={action.pending}
              className="font-mono"
            />
            <p id={slugHint} className={cn("text-xs", slugBad ? "text-danger" : "text-muted")}>
              {slugBad ?? `/partners/${slug}`}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={noteId}>Note to the distributor (optional)</Label>
            <Textarea id={noteId} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} readOnly={action.pending} />
          </div>
        </div>
        <div className="min-w-0 space-y-3">
          <h3 className="text-[13px] font-semibold text-text">Initial terms</h3>
          <TermsFields kind="RESELLER" draft={terms} onChange={setTerms} plans={plans} todayKey={todayKey} disabled={action.pending} />
        </div>
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {problem && <p className="text-xs text-muted sm:mr-auto">{problem}</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Approve and invite
        </Button>
      </div>
    </form>
  );
}

// ─── Applications ────────────────────────────────────────────────────────────────────────────────

const SETTABLE: PartnerApplicationStatus[] = ["NEW", "REVIEWING", "DECLINED", "SPAM"];

/** An application's status (accepted only by turning it into a partner) and staff's notes. */
export function ApplicationUpdateButton({ application }: { application: { id: string; companyName: string; status: PartnerApplicationStatus; notes: string | null } }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ status: PartnerApplicationStatus }>();
  const [open, setOpen] = useState(false);

  function ask(on: boolean) {
    action.reset();
    setOpen(on);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => ask(true)} aria-label={`Update ${application.companyName}'s application`}>
        <NotebookPen aria-hidden="true" className="h-4 w-4" />
        Update
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`${application.companyName}'s application`}>
        <ApplicationForm application={application} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function ApplicationForm({
  application,
  action,
  onClose,
}: {
  application: { id: string; companyName: string; status: PartnerApplicationStatus; notes: string | null };
  action: ReturnType<typeof useConsoleAction<{ status: PartnerApplicationStatus }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [status, setStatus] = useState<PartnerApplicationStatus>(application.status);
  const [notes, setNotes] = useState(application.notes ?? "");
  const statusId = `${id}-status`;
  const notesId = `${id}-notes`;
  const change: { status?: PartnerApplicationStatus; notes?: string | null } = {};
  if (status !== application.status) change.status = status;
  if (notes.trim() !== (application.notes ?? "").trim()) change.notes = notes.trim() || null;
  const ready = Object.keys(change).length > 0 && !action.pending;
  const options = SETTABLE.includes(application.status) ? SETTABLE : [application.status, ...SETTABLE];

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleUpdateApplication(application.id, change), { success: "Application updated.", onDone: onClose });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={statusId}>Status</Label>
        <Select id={statusId} value={status} onChange={(e) => setStatus(e.target.value as PartnerApplicationStatus)} disabled={action.pending}>
          {options.map((s) => (
            <option key={s} value={s}>
              {PARTNER_APPLICATION_STATUS[s].label}
            </option>
          ))}
        </Select>
        <p className="text-xs text-muted">Accepted is set by creating the partner from it.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={notesId}>Staff notes (never shown to the applicant)</Label>
        <Textarea id={notesId} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} rows={4} readOnly={action.pending} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
