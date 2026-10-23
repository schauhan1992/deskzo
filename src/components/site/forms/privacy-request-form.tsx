"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { sendPrivacyRequest, type PrivacyRequestInput, type PrivacyRequestResult } from "@/actions/platform/site";
import { PRIVACY_KINDS, PRIVACY_LIMITS, PRIVACY_RELATIONS } from "@/components/site/privacy-fields";
import { Honeypot } from "@/components/site/forms/honeypot";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

type Field = NonNullable<Extract<PrivacyRequestResult, { ok: false }>["field"]>;

const EMPTY: PrivacyRequestInput = { kind: "", name: "", email: "", relation: "", company: "", message: "", website: "" };

/**
 * A privacy request (src/actions/platform/site.ts sendPrivacyRequest): a copy of one's data, a correction,
 * erasure, withdrawing consent, nominating someone, a grievance. Checked here for the obvious and again by
 * the action, which decides; the person gets a reference to quote, and an email saying when we'll reply.
 */
export function PrivacyRequestForm() {
  const [form, setForm] = useState<PrivacyRequestInput>(EMPTY);
  const [problem, setProblem] = useState<{ field?: Field; error: string } | null>(null);
  const [sent, setSent] = useState<{ ref: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof PrivacyRequestInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const invalid = (field: Field) => (problem?.field === field ? { "aria-invalid": true, "aria-describedby": `privacy-${field}-problem` } : {});
  const fieldProblem = (field: Field) =>
    problem?.field === field ? (
      <p id={`privacy-${field}-problem`} className="mt-1.5 text-xs text-danger">
        {problem.error}
      </p>
    ) : null;
  // Data a company keeps in its own Deskzo is the company's to answer for: name it, and we'll point the way.
  const aboutACompany = form.relation === "user" || form.relation === "customer";

  if (sent) {
    return (
      <div role="status" className="flex flex-col items-start gap-4 py-6">
        <span className="grid h-11 w-11 place-items-center rounded-full bg-success-bg text-success">
          <CircleCheck aria-hidden="true" className="h-5 w-5" />
        </span>
        <div>
          <p className="text-lg font-semibold text-text">We&apos;ve received your request{sent.ref ? ` — ${sent.ref}` : ""}.</p>
          <p className="mt-1 text-sm leading-6 text-muted">
            {sent.ref ? "Quote this reference if you write to us about it. " : ""}We&apos;ve emailed you a copy, and we&apos;ll reply within 30 days. We may need
            to confirm it&apos;s you before we act on it.
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setForm(EMPTY);
            setSent(null);
          }}
        >
          Make another request
        </Button>
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
            const result = await sendPrivacyRequest(form);
            if (result.ok) setSent({ ref: result.ref });
            else setProblem({ field: result.field, error: result.error });
          } catch {
            setProblem({ error: "Your request couldn't be sent just now. Please try again in a few minutes." });
          }
        });
      }}
      className="space-y-5"
    >
      <div>
        <Label htmlFor="privacy-kind">What would you like us to do?</Label>
        <Select id="privacy-kind" className="mt-1.5" value={form.kind} onChange={set("kind")} required {...invalid("kind")}>
          <option value="" disabled>
            Choose…
          </option>
          {PRIVACY_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </Select>
        {fieldProblem("kind")}
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="privacy-name">Your name</Label>
          <Input id="privacy-name" className="mt-1.5" value={form.name} onChange={set("name")} autoComplete="name" required maxLength={PRIVACY_LIMITS.name} {...invalid("name")} />
          {fieldProblem("name")}
        </div>
        <div>
          <Label htmlFor="privacy-email">Email</Label>
          <Input id="privacy-email" className="mt-1.5" type="email" inputMode="email" value={form.email} onChange={set("email")} autoComplete="email" required maxLength={PRIVACY_LIMITS.email} {...invalid("email")} />
          {fieldProblem("email")}
        </div>
      </div>
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="privacy-relation">How do you know Deskzo?</Label>
          <Select id="privacy-relation" className="mt-1.5" value={form.relation} onChange={set("relation")} required {...invalid("relation")}>
            <option value="" disabled>
              Choose…
            </option>
            {PRIVACY_RELATIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
          {fieldProblem("relation")}
        </div>
        <div>
          <Label htmlFor="privacy-company">
            Company {!aboutACompany && <span className="font-normal text-subtle">(optional)</span>}
          </Label>
          <Input id="privacy-company" className="mt-1.5" value={form.company} onChange={set("company")} autoComplete="organization" required={aboutACompany} maxLength={PRIVACY_LIMITS.company} {...invalid("company")} />
          {fieldProblem("company")}
        </div>
      </div>
      {aboutACompany && (
        <p className="rounded-lg bg-info-bg px-3 py-2 text-xs leading-5 text-info">
          A company decides what happens to the data it keeps in its own Deskzo — it is the data fiduciary (or controller), and we work on its instructions.
          Asking the company directly is quickest; send it here all the same, and we&apos;ll tell you how to reach them or pass it on.
        </p>
      )}
      <div>
        <Label htmlFor="privacy-message">Your request</Label>
        <Textarea
          id="privacy-message"
          className="mt-1.5 min-h-36"
          value={form.message}
          onChange={set("message")}
          required
          minLength={PRIVACY_LIMITS.messageMin}
          maxLength={PRIVACY_LIMITS.message}
          placeholder="What data, and what you'd like done. To nominate someone, give their name and how to reach them."
          {...invalid("message")}
        />
        {fieldProblem("message")}
      </div>
      <Honeypot id="privacy-website" value={form.website ?? ""} onChange={(website) => setForm((f) => ({ ...f, website }))} />
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
          We use what you send only to answer your request. See the{" "}
          <Link href="/privacy" className="font-medium text-muted underline underline-offset-2 hover:text-text">
            privacy notice
          </Link>
          .
        </p>
        <Button type="submit" className="h-10 px-5" disabled={pending}>
          {pending ? "Sending…" : "Send request"}
        </Button>
      </div>
    </form>
  );
}
