"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link2, LoaderCircle } from "lucide-react";
import { partnerCreateLink } from "@/actions/partners/invitations";
import { CopyField } from "@/components/console/kit/copy-field";
import { InsetBlock } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextField } from "@/components/partners/common/fields";
import { useClock } from "@/components/time/clock-provider";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import { plural } from "@/lib/console-shared/format";
import type { LinkRow } from "@/lib/partners/portal-data";

/**
 * "New referral link": a label to tell it apart, an optional starting plan, and an optional number
 * of days before it stops. The link is the signup page with the partner's code in it; a workspace
 * signed up through it is credited to the partner. It is not a secret — it stays in the list, with a
 * copy button — so the result simply shows it, ready to copy.
 *
 * Rendered only for a role that may make links while the partner account is active; the server
 * refuses anybody else anyway.
 */

type LinkAction = ReturnType<typeof useConsoleAction<LinkRow>>;

const LABEL_MAX = 80;
const DAYS = { min: 1, max: 365 };

export function NewReferralLinkButton({ plans }: { plans: { key: string; name: string }[] }) {
  const action = useConsoleAction<LinkRow>();
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<LinkRow | null>(null);

  function close() {
    if (action.pending) return;
    action.reset();
    setOpen(false);
    setMade(null);
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={() => {
          action.reset();
          setMade(null);
          setOpen(true);
        }}
      >
        <Link2 aria-hidden="true" className="h-4 w-4" />
        New referral link
      </Button>
      <Dialog open={open} onClose={close} title={made ? "Your referral link" : "New referral link"}>
        {made ? <MadeLink link={made} onDone={close} /> : <NewLinkForm plans={plans} action={action} onMade={setMade} onCancel={close} />}
      </Dialog>
    </>
  );
}

function NewLinkForm({ plans, action, onMade, onCancel }: { plans: { key: string; name: string }[]; action: LinkAction; onMade: (link: LinkRow) => void; onCancel: () => void }) {
  const id = useId();
  const labelRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [days, setDays] = useState("");

  useEffect(() => {
    // The dialog focuses its close button in its own effect, which runs after this one — wait a frame.
    const frame = window.requestAnimationFrame(() => labelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanLabel = label.trim();
  const labelOk = cleanLabel.length <= LABEL_MAX;
  const daysText = days.trim();
  const daysN = daysText === "" ? null : /^\d{1,3}$/.test(daysText) && Number(daysText) >= DAYS.min && Number(daysText) <= DAYS.max ? Number(daysText) : NaN;
  const daysOk = !Number.isNaN(daysN);
  const ready = labelOk && daysOk;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!ready || action.pending) return;
    action.run(() => partnerCreateLink({ label: cleanLabel || null, planKey: planKey || null, days: daysN }), {
      success: "Referral link created.",
      onDone: onMade,
    });
  }

  const planId = `${id}-plan`;
  const planHint = `${id}-plan-hint`;

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">
        A link to the signup page that carries your partner code. A workspace signed up through it is credited to you. It doesn&apos;t let anyone sign up
        on its own while signing up needs an invitation.
      </p>
      <TextField
        inputRef={labelRef}
        label="Label"
        value={label}
        onChange={setLabel}
        max={LABEL_MAX}
        placeholder="Website footer"
        readOnly={action.pending}
        hint="Where you'll use it — a web page, a campaign, an event. Optional."
        error={labelOk ? null : `Keep it to ${LABEL_MAX} characters.`}
      />
      <div className="space-y-1.5">
        <Label htmlFor={planId}>Plan</Label>
        <Select id={planId} value={planKey} onChange={(e) => setPlanKey(e.target.value)} disabled={action.pending} aria-describedby={planHint}>
          <option value="">Default plan</option>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
        <p id={planHint} className="text-xs text-muted">
          The plan signup starts on for someone who follows the link. Optional.
        </p>
      </div>
      <TextField
        label="Ends after (days)"
        value={days}
        onChange={setDays}
        inputMode="numeric"
        readOnly={action.pending}
        placeholder="No end"
        hint={daysN === null ? `From ${DAYS.min} to ${DAYS.max}. Leave it empty for a link that doesn't end.` : daysOk ? `Stops working ${plural(daysN as number, "day")} from now.` : undefined}
        error={daysOk ? null : `A whole number from ${DAYS.min} to ${DAYS.max}, or empty.`}
      />
      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready} aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Create link
        </Button>
      </div>
    </form>
  );
}

function MadeLink({ link, onDone }: { link: LinkRow; onDone: () => void }) {
  const clock = useClock();
  const doneRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The form that had focus has just gone; put it where the next step is.
    const frame = window.requestAnimationFrame(() => doneRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="space-y-4 p-0.5">
      <p className="text-sm text-text">
        {link.label ? (
          <>
            <strong className="font-medium">{link.label}</strong> is ready.
          </>
        ) : (
          "Your link is ready."
        )}{" "}
        Share it anywhere — it stays in your list, so you can copy it again later.
      </p>
      <InsetBlock>
        <p className="text-xs font-medium text-muted">Referral link</p>
        <div className="mt-1.5">
          <CopyField value={link.url} label="referral link" />
        </div>
        <p className="mt-2 text-xs text-muted">
          {`Code ${link.code}`}
          {link.planName ? ` · starts on ${link.planName}` : ""}
          {link.expiresAt ? ` · works until ${clock.date(link.expiresAt)}` : " · no end date"}
        </p>
      </InsetBlock>
      <div className="flex justify-end">
        <Button ref={doneRef} type="button" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
