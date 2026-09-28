"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { sendContactRequest } from "@/actions/platform/site";
import { CONTACT_LIMITS, CONTACT_TOPICS, type ContactField, type ContactInput, type ContactTopic } from "@/components/site/contact-fields";
import type { ContactTopicLabels } from "@/components/site/blocks/types";
import { Honeypot } from "@/components/site/forms/honeypot";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

type Props = {
  topics: ContactTopicLabels;
  defaultTopic: ContactTopic;
  submitLabel: string;
  successHeading: string;
  successBody: string;
};

const EMPTY = (topic: ContactTopic): ContactInput => ({ name: "", email: "", company: "", phone: "", topic, message: "", website: "" });

/** The contact form: checked here for the obvious, and again by `sendContactRequest`, which decides. */
export function ContactForm({ topics, defaultTopic, submitLabel, successHeading, successBody }: Props) {
  const [form, setForm] = useState<ContactInput>(() => EMPTY(defaultTopic));
  const [problem, setProblem] = useState<{ field?: ContactField; error: string } | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();
  const set = (key: keyof ContactInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const invalid = (field: ContactField) => (problem?.field === field ? { "aria-invalid": true, "aria-describedby": `contact-${field}-problem` } : {});
  const fieldProblem = (field: ContactField) =>
    problem?.field === field ? (
      <p id={`contact-${field}-problem`} className="mt-1.5 text-xs text-danger">
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
          <p className="text-lg font-semibold text-text">{successHeading}</p>
          <p className="mt-1 text-sm leading-6 text-muted">{successBody}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setForm(EMPTY(defaultTopic));
            setSent(false);
          }}
        >
          Send another message
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
            const result = await sendContactRequest(form);
            if (result.ok) setSent(true);
            else setProblem({ field: result.field, error: result.error });
          } catch {
            setProblem({ error: "Your message couldn't be sent just now. Please try again in a few minutes." });
          }
        });
      }}
      className="space-y-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <Label htmlFor="contact-name">Your name</Label>
          <Input id="contact-name" className="mt-1.5" value={form.name} onChange={set("name")} autoComplete="name" required maxLength={CONTACT_LIMITS.name} {...invalid("name")} />
          {fieldProblem("name")}
        </div>
        <div>
          <Label htmlFor="contact-email">Work email</Label>
          <Input id="contact-email" className="mt-1.5" type="email" inputMode="email" value={form.email} onChange={set("email")} autoComplete="email" required maxLength={CONTACT_LIMITS.email} {...invalid("email")} />
          {fieldProblem("email")}
        </div>
        <div>
          <Label htmlFor="contact-company">Company</Label>
          <Input id="contact-company" className="mt-1.5" value={form.company} onChange={set("company")} autoComplete="organization" required maxLength={CONTACT_LIMITS.company} {...invalid("company")} />
          {fieldProblem("company")}
        </div>
        <div>
          <Label htmlFor="contact-phone">
            Phone <span className="font-normal text-subtle">(optional)</span>
          </Label>
          <Input id="contact-phone" className="mt-1.5" type="tel" inputMode="tel" value={form.phone} onChange={set("phone")} autoComplete="tel" maxLength={CONTACT_LIMITS.phone} {...invalid("phone")} />
          {fieldProblem("phone")}
        </div>
      </div>
      <div>
        <Label htmlFor="contact-topic">What is it about?</Label>
        <Select id="contact-topic" className="mt-1.5" value={form.topic} onChange={set("topic")} {...invalid("topic")}>
          {CONTACT_TOPICS.map((topic) => (
            <option key={topic} value={topic}>
              {topics[topic]}
            </option>
          ))}
        </Select>
        {fieldProblem("topic")}
      </div>
      <div>
        <Label htmlFor="contact-message">Message</Label>
        <Textarea id="contact-message" className="mt-1.5 min-h-36" value={form.message} onChange={set("message")} required minLength={CONTACT_LIMITS.messageMin} maxLength={CONTACT_LIMITS.message} {...invalid("message")} />
        {fieldProblem("message")}
      </div>
      <Honeypot id="contact-website" value={form.website ?? ""} onChange={(website) => setForm((f) => ({ ...f, website }))} />
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
          We use what you send only to reply to you. See the{" "}
          <Link href="/privacy" className="font-medium text-muted underline underline-offset-2 hover:text-text">
            privacy notice
          </Link>
          .
        </p>
        <Button type="submit" className="h-10 px-5" disabled={pending}>
          {pending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
