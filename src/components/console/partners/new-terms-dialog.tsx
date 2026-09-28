"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { LoaderCircle, Plus } from "lucide-react";
import { consoleSetPartnerTerms } from "@/actions/platform/console-partners";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { dayMonthYear } from "@/lib/console-shared/format";
import type { PartnerKind, TermsInput } from "@/lib/partners/types";
import { TermsFields, draftFromTerms, termsFromDraft, termsProblem, type TermsDraft } from "./terms-fields";

/**
 * "New terms" (SELLERS; spec §3.3): a new version of the partner's rates from a day on — today means
 * from now; never backdated. Terms are never edited: the new row takes over at its start, and the one
 * before stays in the history. The form starts from the programme's defaults for this kind (owner
 * decision O1).
 */

const noSubscribe = () => () => {};

export function NewTermsButton({
  partner,
  defaults,
  plans,
  todayKey,
}: {
  partner: { id: string; displayName: string; kind: PartnerKind };
  defaults: TermsInput;
  plans: { key: string; name: string }[];
  todayKey: string;
}) {
  const isClient = useSyncExternalStore(noSubscribe, () => true, () => false);
  const action = useConsoleAction<{ id: string; effectiveFrom: Date }>();
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
        onClick={() => {
          action.reset();
          setOpen(true);
        }}
      >
        <Plus aria-hidden="true" className="h-4 w-4" />
        New terms
      </Button>
      <Dialog open={open && isClient} onClose={close} title={`New terms for ${partner.displayName}`}>
        <TermsForm partner={partner} defaults={defaults} plans={plans} todayKey={todayKey} action={action} onClose={close} />
      </Dialog>
    </>
  );
}

function TermsForm({
  partner,
  defaults,
  plans,
  todayKey,
  action,
  onClose,
}: {
  partner: { id: string; displayName: string; kind: PartnerKind };
  defaults: TermsInput;
  plans: { key: string; name: string }[];
  todayKey: string;
  action: ReturnType<typeof useConsoleAction<{ id: string; effectiveFrom: Date }>>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TermsDraft>(() => draftFromTerms(defaults));
  const problem = termsProblem(draft, partner.kind, todayKey);
  const ready = problem === null && !action.pending;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready) return;
    action.run(() => consoleSetPartnerTerms(partner.id, termsFromDraft(draft, partner.kind)), {
      success: (d) => `New terms set — in force from ${dayMonthYear(d.effectiveFrom)}.`,
      onDone: onClose,
    });
  }

  return (
    <form onSubmit={submit} className="space-y-4 p-0.5" noValidate>
      <p className="text-sm text-text">These replace the terms in force from the day they start. Invoices already paid keep the terms they were paid under.</p>
      <TermsFields kind={partner.kind} draft={draft} onChange={setDraft} plans={plans} todayKey={todayKey} disabled={action.pending} />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:items-center sm:justify-end">
        {problem && <p className="text-xs text-muted sm:mr-auto">{problem}</p>}
        <Button type="button" variant="secondary" onClick={onClose} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-busy={action.pending || undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Save terms
        </Button>
      </div>
    </form>
  );
}
