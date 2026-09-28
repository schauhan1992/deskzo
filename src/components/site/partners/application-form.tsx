"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { applyToPartnerProgramme } from "@/actions/platform/partner-site";
import { APPLICATION_LIMITS, KINDS_WANTED, type KindWanted, type PartnerApplicationField, type PartnerApplicationInput } from "@/components/site/partners/application-fields";
import { Honeypot } from "@/components/site/forms/honeypot";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { Country } from "@/lib/geo/countries";

const L = APPLICATION_LIMITS;

const KIND_WORDS: Record<KindWanted, { label: string; hint: string }> = {
  RESELLER: { label: "Reseller", hint: "You sell to companies and look after them yourself." },
  DISTRIBUTOR: { label: "Distributor", hint: "You also bring in and support resellers in your countries." },
};

type Form = Required<PartnerApplicationInput>;

const EMPTY: Form = { companyName: "", companyWebsite: "", country: "", kindWanted: "RESELLER", contactName: "", contactEmail: "", contactPhone: "", message: "", website: "" };

/**
 * "Become a partner" — the application: checked here for the obvious, and again by
 * `applyToPartnerProgramme` (src/actions/platform/partner-site.ts), which decides. Built like the
 * site's contact form (../forms/contact-form.tsx): each refusal shown at its field, the honeypot
 * hidden the same way, a thank-you in place of the form once it is sent.
 */
export function PartnerApplicationForm({ countries }: { countries: Country[] }) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [problem, setProblem] = useState<{ field?: PartnerApplicationField; error: string } | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const invalid = (field: PartnerApplicationField) => (problem?.field === field ? { "aria-invalid": true, "aria-describedby": `partner-${field}-problem` } : {});
  const fieldProblem = (field: PartnerApplicationField) =>
    problem?.field === field ? (
      <p id={`partner-${field}-problem`} className="mt-1.5 text-xs text-danger">
        {problem.error}
      </p>
    ) : null;

  if (sent) {
    return (
      <div role="status" className="flex flex-col items-start gap-4 py-6">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-success-bg text-success">
          <CircleCheck aria-hidden="true" className="h-5 w-5" />
        </span>
        <div>
          <p className="text-lg font-semibold text-text">Thank you — your application is in.</p>
          <p className="mt-1 text-sm leading-6 text-muted">We read every application, and we will reply by email.</p>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setProblem(null);
        startTransition(async () => {
          try {
            const result = await applyToPartnerProgramme(form);
            if (result.ok) setSent(true);
            else setProblem({ field: result.field, error: result.error });
          } catch {
            setProblem({ error: "Your application couldn't be sent just now. Please try again in a few minutes." });
          }
        });
      }}
      className="space-y-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="partner-companyName">Company</Label>
          <Input id="partner-companyName" className="mt-1.5" value={form.companyName} onChange={set("companyName")} autoComplete="organization" required maxLength={L.company} {...invalid("companyName")} />
          {fieldProblem("companyName")}
        </div>
        <div>
          <Label htmlFor="partner-companyWebsite">
            Company website <span className="font-normal text-subtle">(optional)</span>
          </Label>
          <Input id="partner-companyWebsite" className="mt-1.5" inputMode="url" placeholder="yourcompany.com" value={form.companyWebsite} onChange={set("companyWebsite")} autoComplete="url" maxLength={L.website} {...invalid("companyWebsite")} />
          {fieldProblem("companyWebsite")}
        </div>
      </div>
      <div>
        <Label htmlFor="partner-country">Country</Label>
        <Select id="partner-country" className="mt-1.5" value={form.country} onChange={set("country")} required {...invalid("country")}>
          <option value="" disabled>
            Choose your country
          </option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>
              {c.name}
            </option>
          ))}
        </Select>
        {fieldProblem("country")}
      </div>
      <fieldset aria-describedby={problem?.field === "kindWanted" ? "partner-kindWanted-problem" : undefined}>
        <legend className="text-[13px] font-medium text-muted">I want to be a</legend>
        <div className="mt-1.5 grid gap-3 sm:grid-cols-2">
          {KINDS_WANTED.map((kind) => (
            <label key={kind} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:bg-surface-sunken has-[:checked]:border-brand has-[:checked]:bg-brand-subtle">
              <input type="radio" name="partner-kind" value={kind} checked={form.kindWanted === kind} onChange={set("kindWanted")} className="mt-1 accent-brand" />
              <span>
                <span className="block text-sm font-medium text-text">{KIND_WORDS[kind].label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted">{KIND_WORDS[kind].hint}</span>
              </span>
            </label>
          ))}
        </div>
        {fieldProblem("kindWanted")}
      </fieldset>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="partner-contactName">Your name</Label>
          <Input id="partner-contactName" className="mt-1.5" value={form.contactName} onChange={set("contactName")} autoComplete="name" required maxLength={L.name} {...invalid("contactName")} />
          {fieldProblem("contactName")}
        </div>
        <div>
          <Label htmlFor="partner-contactEmail">Work email</Label>
          <Input id="partner-contactEmail" className="mt-1.5" type="email" inputMode="email" value={form.contactEmail} onChange={set("contactEmail")} autoComplete="email" required maxLength={L.email} {...invalid("contactEmail")} />
          {fieldProblem("contactEmail")}
        </div>
      </div>
      <div className="sm:w-1/2 sm:pr-2.5">
        <Label htmlFor="partner-contactPhone">
          Phone <span className="font-normal text-subtle">(optional)</span>
        </Label>
        <Input id="partner-contactPhone" className="mt-1.5" type="tel" inputMode="tel" value={form.contactPhone} onChange={set("contactPhone")} autoComplete="tel" maxLength={L.phone} {...invalid("contactPhone")} />
        {fieldProblem("contactPhone")}
      </div>
      <div>
        <Label htmlFor="partner-message">About your company</Label>
        <p id="partner-message-hint" className="mt-0.5 text-xs text-subtle">
          {`Who your customers are, where you work, and how you would sell and support us. At least ${L.messageMin} characters.`}
        </p>
        <Textarea
          id="partner-message"
          className="mt-1.5 min-h-36"
          value={form.message}
          onChange={set("message")}
          required
          minLength={L.messageMin}
          maxLength={L.message}
          aria-describedby={problem?.field === "message" ? "partner-message-hint partner-message-problem" : "partner-message-hint"}
          aria-invalid={problem?.field === "message" || undefined}
        />
        {fieldProblem("message")}
      </div>
      <Honeypot id="partner-website" value={form.website} onChange={(website) => setForm((f) => ({ ...f, website }))} />
      {problem && !problem.field && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {problem.error}
        </p>
      )}
      {problem?.field && (
        <p role="alert" className="sr-only">
          {problem.error}
        </p>
      )}
      <div className="flex flex-col-reverse gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-subtle">
          We use what you send only to review your application and reply to you. See the{" "}
          <Link href="/privacy" className="font-medium text-muted underline underline-offset-2 hover:text-text">
            privacy notice
          </Link>
          .
        </p>
        <Button type="submit" className="h-10 px-5" disabled={pending}>
          {pending ? "Sending…" : "Send application"}
        </Button>
      </div>
    </form>
  );
}
