"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Handshake, LoaderCircle } from "lucide-react";
import { partnerRegisterDeal } from "@/actions/partners/deals";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { TextAreaField, TextField } from "@/components/partners/common/fields";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Label, Select } from "@/components/ui/input";
import type { DealRow } from "@/lib/partners/portal-data";

/**
 * "Register a company" (spec §4.3): the company's name, the domain its people's email addresses are
 * on, its country (one of the partner's territories), optionally a contact and the plan it is
 * expected to take, and a note for staff. Staff approve or decline it; the server refuses a public
 * mail domain, a country outside the territories, and a company already a customer or registered —
 * with one message that names nobody — and those refusals appear here exactly as returned.
 *
 * Rendered only for a role that may register while the partner account is active; the server refuses
 * anybody else anyway.
 */

type RegisterAction = ReturnType<typeof useConsoleAction<DealRow>>;
type Territory = { code: string; name: string };

const COMPANY = { min: 2, max: 160 };
const CONTACT_NAME_MAX = 120;
const NOTE_MAX = 1000;
/** A plain shape test, so an obvious slip is caught at once; the server's own test is the one that counts. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN = /^[^\s@/]+\.[^\s@/]+$/;

export function RegisterDealButton({ territories, plans, dealDays }: { territories: Territory[]; plans: { key: string; name: string }[]; dealDays: number }) {
  const action = useConsoleAction<DealRow>();
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
        <Handshake aria-hidden="true" className="h-4 w-4" />
        Register a company
      </Button>
      <Dialog open={open} onClose={close} title="Register a company">
        <RegisterForm territories={territories} plans={plans} dealDays={dealDays} action={action} onDone={close} />
      </Dialog>
    </>
  );
}

/** The domain as the server will read it — scheme, path, "www." and an address's local part dropped — so the hint can show it back. */
function domainOf(raw: string): string {
  let text = raw.trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "");
  if (text.includes("@")) text = text.slice(text.lastIndexOf("@") + 1);
  return text.replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
}

function RegisterForm({
  territories,
  plans,
  dealDays,
  action,
  onDone,
}: {
  territories: Territory[];
  plans: { key: string; name: string }[];
  dealDays: number;
  action: RegisterAction;
  onDone: () => void;
}) {
  const id = useId();
  const companyRef = useRef<HTMLInputElement>(null);
  const [company, setCompany] = useState("");
  const [domain, setDomain] = useState("");
  const [country, setCountry] = useState(territories.length === 1 ? territories[0]!.code : "");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [planKey, setPlanKey] = useState("");
  const [note, setNote] = useState("");
  const [tried, setTried] = useState(false);

  useEffect(() => {
    // The dialog focuses its close button in its own effect, which runs after this one — wait a frame.
    const frame = window.requestAnimationFrame(() => companyRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const cleanCompany = company.replace(/\s+/g, " ").trim();
  const cleanDomain = domainOf(domain);
  const cleanEmail = contactEmail.trim().toLowerCase();
  const companyOk = cleanCompany.length >= COMPANY.min && cleanCompany.length <= COMPANY.max;
  const domainOk = DOMAIN.test(cleanDomain) && cleanDomain.length <= 253;
  const countryOk = territories.some((t) => t.code === country);
  const contactNameOk = contactName.trim().length <= CONTACT_NAME_MAX;
  const emailOk = cleanEmail === "" || EMAIL.test(cleanEmail);
  const noteOk = note.trim().length <= NOTE_MAX;
  const valid = companyOk && domainOk && countryOk && contactNameOk && emailOk && noteOk;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTried(true);
    if (!valid || action.pending) return;
    action.run(
      () =>
        partnerRegisterDeal({
          companyName: cleanCompany,
          domain: cleanDomain,
          country,
          contactName: contactName.trim() || null,
          contactEmail: cleanEmail || null,
          expectedPlanKey: planKey || null,
          note: note.trim() || null,
        }),
      { success: (deal) => `${deal.companyName} registered — staff will approve or decline it.`, onDone },
    );
  }

  const countryId = `${id}-country`;
  const countryHint = `${id}-country-hint`;
  const planId = `${id}-plan`;
  const contactsId = `${id}-contacts`;

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-0.5" aria-busy={action.pending || undefined}>
      <p className="text-sm text-muted">
        {`Staff approve or decline each registration. Once approved, the company is protected for you for ${dealDays} days: a workspace signed up from an address on its domain is credited to you, ahead of any code or link.`}
      </p>
      <TextField
        inputRef={companyRef}
        label="Company"
        value={company}
        onChange={setCompany}
        max={COMPANY.max}
        required
        placeholder="Acme Traders Pvt Ltd"
        readOnly={action.pending}
        error={tried && !companyOk ? `Give the company's name (${COMPANY.min} to ${COMPANY.max} characters).` : null}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Email domain"
          value={domain}
          onChange={setDomain}
          required
          mono
          placeholder="acme.example"
          readOnly={action.pending}
          hint={cleanDomain && domainOk && cleanDomain !== domain.trim().toLowerCase() ? `Registered as ${cleanDomain}.` : "The domain its people's email addresses are on — not a public mail provider."}
          error={tried && !domainOk ? "Give the company's email domain, like acme.example." : null}
        />
        <div className="space-y-1.5">
          <Label htmlFor={countryId}>
            Country
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          </Label>
          <Select
            id={countryId}
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            disabled={action.pending}
            aria-required
            aria-invalid={tried && !countryOk ? true : undefined}
            aria-describedby={countryHint}
          >
            {territories.length !== 1 && <option value="">Choose a country</option>}
            {territories.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </Select>
          <p id={countryHint} className={tried && !countryOk ? "text-xs text-danger" : "text-xs text-muted"}>
            {tried && !countryOk ? "Choose the company's country." : "Only your territories."}
          </p>
        </div>
      </div>

      <fieldset className="space-y-3" aria-describedby={contactsId}>
        <legend className="text-[13px] font-medium text-muted">Contact</legend>
        <p id={contactsId} className="text-xs text-muted">
          Optional. The contact&apos;s name and email are kept only for this registration.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Contact name"
            value={contactName}
            onChange={setContactName}
            max={CONTACT_NAME_MAX}
            placeholder="Priya Shah"
            readOnly={action.pending}
            error={contactNameOk ? null : `Keep it to ${CONTACT_NAME_MAX} characters.`}
          />
          <TextField
            label="Contact email"
            type="email"
            inputMode="email"
            value={contactEmail}
            onChange={setContactEmail}
            mono
            placeholder={cleanDomain && domainOk ? `priya@${cleanDomain}` : "priya@acme.example"}
            readOnly={action.pending}
            hint={cleanDomain && domainOk ? `On ${cleanDomain}.` : "On the company's domain."}
            error={tried && !emailOk ? "That doesn't look like an email address." : null}
          />
        </div>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor={planId}>Expected plan</Label>
        <Select id={planId} value={planKey} onChange={(e) => setPlanKey(e.target.value)} disabled={action.pending}>
          <option value="">Not sure yet</option>
          {plans.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>

      <TextAreaField
        label="Note for staff"
        value={note}
        onChange={setNote}
        max={NOTE_MAX}
        readOnly={action.pending}
        placeholder="Where things stand, and anything staff should know."
        hint="Optional."
        error={noteOk ? null : `Keep it to ${NOTE_MAX.toLocaleString("en-IN")} characters.`}
      />

      <ActionNoticeRegion notice={action.error ? { tone: "error", message: action.error } : null} />
      <div className="sticky bottom-0 flex flex-col-reverse gap-2 bg-surface pt-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onDone} disabled={action.pending}>
          Cancel
        </Button>
        <Button type="submit" aria-disabled={action.pending || undefined} aria-busy={action.pending || undefined} className={action.pending ? "cursor-wait opacity-70" : undefined}>
          {action.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
          Register
        </Button>
      </div>
    </form>
  );
}
