"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LoaderCircle, Plus, UserPlus } from "lucide-react";
import { consoleConvertApplication, consoleCreatePartner } from "@/actions/platform/console-partners";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import type { ConsoleResult } from "@/actions/platform/console";
import type { PartnerInput, PartnerKind, TermsInput } from "@/lib/partners/types";
import { partnerPath, suggestSlug } from "./format";
import { PartnerFields, emptyPartnerDraft, partnerFromDraft, partnerProblem, type DistributorOption, type PartnerDraft } from "./partner-fields";
import { TermsFields, draftFromTerms, termsFromDraft, termsProblem, type TermsDraft } from "./terms-fields";

/**
 * New partner (MANAGERS; spec §3.1, §3.3): the profile and the initial terms in one dialog, sent as
 * one `consoleCreatePartner` — a partner is never made without terms, and starts ONBOARDING. Then the
 * page moves to its 360. The terms start from the programme's defaults (owner decision O1), handed in
 * by the server page; switching the kind before touching them switches to that kind's defaults.
 *
 * "Create partner from this" on an application is the same dialog, prefilled from what the applicant
 * sent, and saved through `consoleConvertApplication` (the partner is made and the application
 * accepted together).
 *
 * The button is rendered for MANAGERS only, so no other role's page carries its wording; the dialog
 * also opens from the address (`?new=1`, the command palette) once hydrated, and drops the param when
 * it closes.
 */

export type PartnerFormOptions = {
  distributors: DistributorOption[];
  plans: { key: string; name: string }[];
  taxIdKinds: readonly string[];
  /** DEFAULT_TERMS (src/lib/partners/types.ts), from the server page. */
  defaults: Record<"DISTRIBUTOR" | "RESELLER", TermsInput>;
  /** Today on India's calendar, from the loader's clock. */
  todayKey: string;
};

export type ApplicationSeed = {
  id: string;
  companyName: string;
  website: string | null;
  country: string;
  kindWanted: PartnerKind;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
};

type CreateInput = PartnerInput & { terms: TermsInput };

const noSubscribe = () => () => {};

function seedDraft(app: ApplicationSeed): PartnerDraft {
  return {
    ...emptyPartnerDraft(app.kindWanted),
    slug: suggestSlug(app.companyName),
    legalName: app.companyName,
    displayName: app.companyName,
    country: app.country,
    territories: app.country ? [app.country] : [],
    contactName: app.contactName,
    contactEmail: app.contactEmail,
    contactPhone: app.contactPhone ?? "",
    website: app.website ?? "",
  };
}

export function NewPartnerButton({ options }: { options: PartnerFormOptions }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ slug: string }>();
  const asked = searchParams.get("new") === "1";
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(false);
  // Opened by the address: adjusted while rendering, so it is open on the first paint after the param arrives.
  if (asked !== seen) {
    setSeen(asked);
    if (asked) setOpen(true);
  }

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    const params = new URLSearchParams(window.location.search);
    if (params.has("new")) {
      params.delete("new");
      const query = params.toString();
      router.replace(query ? `${window.location.pathname}?${query}` : window.location.pathname, { scroll: false });
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
        New partner
      </Button>
      <Dialog open={open && isClient} onClose={close} title="New partner" wide>
        <PartnerCreateForm
          initial={emptyPartnerDraft()}
          options={options}
          submitLabel="Create partner"
          action={action}
          onClose={close}
          onCreated={() => setOpen(false)}
          send={(input) => consoleCreatePartner(input)}
          success={(name) => `Partner created — ${name} starts onboarding.`}
        />
      </Dialog>
    </>
  );
}

/** "Create partner from this": the New partner dialog, prefilled from an application. */
export function ConvertApplicationButton({ application, options }: { application: ApplicationSeed; options: PartnerFormOptions }) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ slug: string }>();
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
        Create partner from this
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`New partner from ${application.companyName}'s application`} wide>
        <PartnerCreateForm
          initial={seedDraft(application)}
          options={options}
          submitLabel="Create partner"
          action={action}
          onClose={close}
          onCreated={() => setOpen(false)}
          send={(input) => consoleConvertApplication(application.id, input)}
          success={(name) => `Partner created from the application — ${name} starts onboarding.`}
        />
      </Dialog>
    </>
  );
}

/** The form. Mounted only while the dialog is open, so it starts from its seed each time. */
function PartnerCreateForm({
  initial,
  options,
  submitLabel,
  action,
  onClose,
  onCreated,
  send,
  success,
}: {
  initial: PartnerDraft;
  options: PartnerFormOptions;
  submitLabel: string;
  action: ReturnType<typeof useConsoleAction<{ slug: string }>>;
  onClose: () => void;
  /** Closes the dialog without touching the address: the page is about to move to the new partner. */
  onCreated: () => void;
  send: (input: CreateInput) => Promise<ConsoleResult<{ slug: string }>>;
  success: (name: string) => string;
}) {
  const router = useRouter();
  const [partner, setPartner] = useState<PartnerDraft>(initial);
  const [terms, setTerms] = useState<TermsDraft>(() => draftFromTerms(options.defaults[initial.kind]));
  const [termsTouched, setTermsTouched] = useState(false);
  const rootRef = useRef<HTMLFormElement>(null);
  const headingId = useId();

  useEffect(() => {
    // The dialog focuses its close button in its own effect, which runs after this one.
    const frame = window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>("input:not([type='hidden'])")?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function onPartner(next: PartnerDraft) {
    // A different kind before the terms were touched: start from that kind's defaults instead.
    if (next.kind !== partner.kind && !termsTouched) setTerms(draftFromTerms(options.defaults[next.kind]));
    setPartner(next);
  }

  function onTerms(next: TermsDraft) {
    setTermsTouched(true);
    setTerms(next);
  }

  const problem = partnerProblem(partner, options.distributors) ?? termsProblem(terms, partner.kind, options.todayKey);
  const ready = problem === null && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    const name = partner.displayName.trim();
    action.run(() => send({ ...partnerFromDraft(partner), terms: termsFromDraft(terms, partner.kind) }), {
      success: success(name),
      refresh: false,
      onDone: (made) => {
        onCreated();
        router.push(partnerPath(made.slug));
      },
    });
  }

  return (
    <form ref={rootRef} onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby={`${headingId}-profile`} className="min-w-0 space-y-3">
          <h3 id={`${headingId}-profile`} className="text-[13px] font-semibold text-text">
            Profile
          </h3>
          <PartnerFields draft={partner} onChange={onPartner} distributors={options.distributors} taxIdKinds={options.taxIdKinds} disabled={action.pending} />
        </section>
        <section aria-labelledby={`${headingId}-terms`} className="min-w-0 space-y-3">
          <h3 id={`${headingId}-terms`} className="text-[13px] font-semibold text-text">
            Initial terms
          </h3>
          <p className="text-xs text-muted">Every partner starts with terms. These are the programme&apos;s defaults for this kind — change anything before saving.</p>
          <TermsFields kind={partner.kind} draft={terms} onChange={onTerms} plans={options.plans} todayKey={options.todayKey} disabled={action.pending} />
        </section>
      </div>

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />

      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {problem && <p className="text-xs text-muted sm:mr-auto">{problem}</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
