"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Pencil, RefreshCcw, UserPlus } from "lucide-react";
import { consoleInvitePartnerAdmin, consoleSetPartnerStatus, consoleUpdatePartner } from "@/actions/platform/console-partners";
import { ConfirmBody } from "@/components/console/kit/confirm-dialog";
import { ImpactList } from "@/components/console/kit/impact";
import { OnceSecret } from "@/components/console/kit/once-secret";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerKind, PartnerStatus } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { EMAIL, partnerPath } from "./format";
import { PartnerFields, emptyPartnerDraft, partnerFromDraft, partnerProblem, type DistributorOption, type PartnerDraft } from "./partner-fields";
import { RevealPayoutButton } from "./payout";

/**
 * The partner 360's action bar (spec §9.2): Change status, Edit and Invite partner admin for
 * MANAGERS, Reveal payout for PAYERS. Drawn per role — a role that cannot act sees none of it — and
 * every action checks the role again itself. Dialogs render nothing while closed, so none of their
 * wording is in the page's first markup.
 */

export type HeaderPartner = {
  id: string;
  slug: string;
  displayName: string;
  kind: PartnerKind;
  status: PartnerStatus;
  termsInForce: boolean;
  activeAdmins: number;
  customersStillAttributed: number;
  payoutOnFile: boolean;
};

/** What Edit starts from: the partner as the Overview loader read it. */
export type EditSeed = {
  kind: PartnerKind;
  parentSlug: string | null;
  legalName: string;
  displayName: string;
  country: string;
  territories: string[];
  contact: { name: string; email: string; phone: string | null };
  website: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null };
  /** Null without money: the editor then leaves them as they are. */
  taxIds: { kind: string; value: string }[] | null;
  publicListing: boolean;
  publicBlurb: string | null;
};

const noSubscribe = () => () => {};

export function PartnerHeaderActions({
  partner,
  caps,
  edit,
  distributors,
  taxIdKinds,
}: {
  partner: HeaderPartner;
  caps: Caps;
  edit: EditSeed | null;
  distributors: DistributorOption[];
  taxIdKinds: readonly string[];
}) {
  const terminated = partner.status === "TERMINATED";
  return (
    <>
      {caps.payPartners && <RevealPayoutButton partner={{ id: partner.id, displayName: partner.displayName }} onFile={partner.payoutOnFile} />}
      {caps.managePartners && !terminated && <InviteAdminButton partner={partner} />}
      {caps.managePartners && edit && <EditPartnerButton partner={partner} seed={edit} distributors={distributors} taxIdKinds={taxIdKinds} />}
      {caps.managePartners && !terminated && <ChangeStatusButton partner={partner} />}
    </>
  );
}

// ─── Change status ───────────────────────────────────────────────────────────────────────────────

const NEXT: Record<PartnerStatus, PartnerStatus[]> = {
  ONBOARDING: ["ACTIVE", "TERMINATED"],
  ACTIVE: ["SUSPENDED", "TERMINATED"],
  SUSPENDED: ["ACTIVE", "TERMINATED"],
  TERMINATED: [],
};

function choiceLabel(from: PartnerStatus, to: PartnerStatus): string {
  if (to === "ACTIVE") return from === "SUSPENDED" ? "Reactivate" : "Activate";
  if (to === "SUSPENDED") return "Suspend";
  if (to === "TERMINATED") return "Terminate";
  return "Set back to onboarding";
}

const DONE: Record<PartnerStatus, string> = {
  ACTIVE: "Partner activated.",
  SUSPENDED: "Partner suspended.",
  TERMINATED: "Partner terminated.",
  ONBOARDING: "Partner set back to onboarding.",
};

function ChangeStatusButton({ partner }: { partner: HeaderPartner }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<unknown>();
  const [open, setOpen] = useState(false);
  const choices = NEXT[partner.status];
  const [target, setTarget] = useState<PartnerStatus>(choices[0] ?? "TERMINATED");
  const name = useId();

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  const activating = target === "ACTIVE" && partner.status === "ONBOARDING";
  const blocked = activating ? (!partner.termsInForce ? "It has no commission terms in force — set its terms first." : partner.activeAdmins === 0 ? "It has no active admin — invite its first admin first." : null) : null;

  const impact =
    target === "TERMINATED"
      ? [
          { label: "Signing in", value: "Refused; every session ends", tone: "danger" as const },
          { label: "Invitation codes and referral links", value: "Ended now" },
          { label: "Pending deals and requests", value: "Withdrawn" },
          { label: "Its customers", value: partner.customersStillAttributed ? `${plural(partner.customersStillAttributed, "workspace")} stay attributed — reassign them` : "None attributed" },
          { label: "Commission", value: "None on invoices paid from now; what is owed is still paid" },
        ]
      : target === "SUSPENDED"
        ? [
            { label: "Selling", value: "Stops — no new codes, links or deals; its codes stop attributing", tone: "warning" as const },
            { label: "Signing in, team and requests", value: "Still work" },
            { label: "Commission", value: "Keeps accruing on its customers" },
          ]
        : [
            { label: "Selling", value: "Codes, links and deal registrations work", tone: "success" as const },
            ...(activating ? [{ label: "Needs", value: "Terms in force and an active admin" }] : []),
          ];

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setTarget(choices[0] ?? "TERMINATED");
          setOpen(true);
        }}
      >
        <RefreshCcw aria-hidden="true" className="h-4 w-4" />
        Change status
      </Button>
      <Dialog open={open && isClient} onClose={close} title="Change status">
        <div className="space-y-4 p-0.5">
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium text-muted">{`${partner.displayName} is ${partner.status.toLowerCase()} now. Change it to`}</legend>
            <div className="flex flex-wrap gap-4">
              {choices.map((to) => (
                <label key={to} className="inline-flex cursor-pointer items-center gap-2 text-sm text-text">
                  <input
                    type="radio"
                    name={name}
                    value={to}
                    checked={target === to}
                    onChange={() => {
                      action.reset();
                      setTarget(to);
                    }}
                    disabled={action.pending}
                    className="h-4 w-4 accent-brand"
                  />
                  <span className={cn(to === "TERMINATED" && "text-danger")}>{choiceLabel(partner.status, to)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {/* Keyed by the choice: the reason and the typed address start empty for each. */}
          <ConfirmBody
            key={target}
            confirmLabel={`${choiceLabel(partner.status, target)} partner`}
            tone={target === "TERMINATED" ? "danger" : "primary"}
            reason={{ label: "Reason (kept in the audit log, never shown to the partner)", minLength: 3, maxLength: 500 }}
            typed={target === "TERMINATED" ? partner.slug : undefined}
            pending={action.pending}
            error={action.error ?? blocked}
            confirmDisabled={blocked !== null}
            onConfirm={({ reason }) => action.run(() => consoleSetPartnerStatus(partner.id, target, reason), { success: DONE[target], onDone: () => setOpen(false) })}
            onCancel={close}
          >
            <p>
              {target === "TERMINATED"
                ? "Terminating is final: the partner can't sign in again, and it can't be undone."
                : target === "SUSPENDED"
                  ? "It keeps its customers and its commission, and stops selling until it is reactivated."
                  : "It can sell: invitation codes, referral links and deal registrations."}
            </p>
            <ImpactList items={impact} />
          </ConfirmBody>
        </div>
      </Dialog>
    </>
  );
}

// ─── Edit ────────────────────────────────────────────────────────────────────────────────────────

function draftOf(slug: string, seed: EditSeed): PartnerDraft {
  const taxIds = (seed.taxIds ?? []).map((t, i) => ({ key: i, kind: t.kind, value: t.value }));
  return {
    ...emptyPartnerDraft(seed.kind),
    slug,
    parentSlug: seed.parentSlug ?? "",
    legalName: seed.legalName,
    displayName: seed.displayName,
    country: seed.country,
    territories: seed.territories,
    contactName: seed.contact.name,
    contactEmail: seed.contact.email,
    contactPhone: seed.contact.phone ?? "",
    website: seed.website ?? "",
    line1: seed.address.line1 ?? "",
    line2: seed.address.line2 ?? "",
    city: seed.address.city ?? "",
    region: seed.address.region ?? "",
    postalCode: seed.address.postalCode ?? "",
    taxIds,
    publicListing: seed.publicListing,
    publicBlurb: seed.publicBlurb ?? "",
    seq: taxIds.length,
  };
}

function EditPartnerButton({ partner, seed, distributors, taxIdKinds }: { partner: HeaderPartner; seed: EditSeed; distributors: DistributorOption[]; taxIdKinds: readonly string[] }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ slug: string; changed: string[] }>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Pencil aria-hidden="true" className="h-4 w-4" />
        Edit
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`Edit ${partner.displayName}`} wide>
        <EditForm partner={partner} seed={seed} distributors={distributors} taxIdKinds={taxIdKinds} action={action} onClose={close} onSaved={() => setOpen(false)} />
      </Dialog>
    </>
  );
}

function EditForm({
  partner,
  seed,
  distributors,
  taxIdKinds,
  action,
  onClose,
  onSaved,
}: {
  partner: HeaderPartner;
  seed: EditSeed;
  distributors: DistributorOption[];
  taxIdKinds: readonly string[];
  action: ReturnType<typeof useConsoleAction<{ slug: string; changed: string[] }>>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<PartnerDraft>(() => draftOf(partner.slug, seed));
  const withTaxIds = seed.taxIds !== null;
  const problem = partnerProblem(draft, distributors);
  const ready = problem === null && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const input = partnerFromDraft(draft);
    if (!withTaxIds) delete input.taxIds;
    action.run(() => consoleUpdatePartner(partner.id, input), {
      success: (d) => (d.changed.length ? `Partner updated — ${plural(d.changed.length, "field")} changed.` : "Nothing needed changing."),
      onDone: (d) => {
        onSaved();
        // A new address moves the page with it; the old one would be a 404.
        if (d.slug !== partner.slug) router.replace(partnerPath(d.slug));
      },
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <PartnerFields draft={draft} onChange={setDraft} distributors={distributors} taxIdKinds={taxIdKinds} disabled={action.pending} withTaxIds={withTaxIds} />
      <p className="text-xs text-muted">The partner&apos;s admins can change its display name, phone, website and public listing themselves; the rest reaches staff as a request.</p>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {problem && <p className="text-xs text-muted sm:mr-auto">{problem}</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save changes
        </Button>
      </div>
    </form>
  );
}

// ─── Invite partner admin ────────────────────────────────────────────────────────────────────────

function InviteAdminButton({ partner }: { partner: HeaderPartner }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ setupUrl: string; emailed: boolean }>();
  const [open, setOpen] = useState(false);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <UserPlus aria-hidden="true" className="h-4 w-4" />
        Invite partner admin
      </Button>
      <Dialog open={open && isClient} onClose={close} title="Invite partner admin">
        <InviteForm partner={partner} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

/** The form, then the link — mounted only while the dialog is open, so the link is gone once it closes. */
function InviteForm({
  partner,
  action,
  onClose,
}: {
  partner: HeaderPartner;
  action: ReturnType<typeof useConsoleAction<{ setupUrl: string; emailed: boolean }>>;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ email: string; setupUrl: string; emailed: boolean } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => nameRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  if (sent) {
    return (
      <OnceSecret
        label={`Set-password link for ${sent.email}`}
        value={sent.setupUrl}
        copyLabel="Copy link"
        note={
          sent.emailed
            ? "Emailed to them. Shown once here in case the mail does not arrive — it can't be retrieved later."
            : "The email could not be sent — pass this link on yourself. Shown once — it can't be retrieved later."
        }
        onDone={onClose}
      />
    );
  }

  const nameId = `${id}-name`;
  const emailId = `${id}-email`;
  const emailBad = email.trim() !== "" && !EMAIL.test(email.trim());
  const ready = name.trim().length >= 2 && EMAIL.test(email.trim()) && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const address = email.trim();
    action.run(() => consoleInvitePartnerAdmin(partner.id, { email: address, name: name.trim() }), {
      success: `Partner admin invited — ${address}.`,
      onDone: (d) => setSent({ email: address, setupUrl: d.setupUrl, emailed: d.emailed }),
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-text">{`Adds an admin to ${partner.displayName}'s partner portal. They choose their own password from a one-time link.`}</p>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" readOnly={action.pending} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={emailId}>Email</Label>
        <Input id={emailId} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" aria-invalid={emailBad || undefined} readOnly={action.pending} />
      </div>
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Send invitation
        </Button>
      </div>
    </form>
  );
}
