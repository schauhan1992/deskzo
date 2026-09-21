"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import type { getForm } from "@/actions/marketing-public";
import { submitForm } from "@/actions/marketing-public";
import { validateAnswers, type Answers, type FormField } from "@/lib/marketing/form-fields";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

type Form = NonNullable<Awaited<ReturnType<typeof getForm>>>;

/**
 * The public enquiry form.
 *
 * The questions come from the form's own spec rather than from this file. That is the whole point:
 * an admin who adds "How many seats?" gets that question, and until recently got a hardcoded set
 * instead — the column was stored, fetched, and then quietly ignored.
 *
 * Validation runs here and again in `submitForm`, through the same `validateAnswers`. The copy here
 * is only so somebody sees which box is wrong before they send; the server's copy is the one that
 * decides.
 *
 * Two anti-spam measures, both invisible to a real person: a honeypot field a browser never shows
 * and a human never fills, and the time the form was on screen. A submission that arrives in under
 * two seconds was not typed. Neither taxes the people you actually want, which is the problem with
 * a CAPTCHA.
 */
export function InboundForm({ form }: { form: Form }) {
  // Read in an effect rather than during render: the clock is not a pure value, and the React
  // compiler is right to refuse it. Null until mounted, which also means a submission from a
  // client that never ran the effect simply skips the timing check rather than failing it.
  const openedAt = useRef<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const [answers, setAnswers] = useState<Answers>(() =>
    Object.fromEntries(form.fields.map((f) => [f.key, ""])),
  );
  const [honeypot, setHoneypot] = useState("");

  const set = (key: string) => (value: string) => setAnswers((a) => ({ ...a, [key]: value }));

  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  // Shown only once somebody has tried to send. Marking every empty box red the moment the page
  // loads tells a person they have done something wrong before they have done anything at all.
  const errors = validateAnswers(form.fields, answers);
  const showErrors = touched;

  if (done) {
    return (
      <Card className="mx-auto max-w-lg">
        <CardContent className="space-y-3 py-12 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
          <h1 className="text-lg font-semibold text-text">Thank you.</h1>
          <p className="text-sm text-muted">{done}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-lg">
      <CardContent className="space-y-5 py-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-text">{form.headline ?? form.name}</h1>
          {form.intro && <p className="text-sm text-muted">{form.intro}</p>}
        </div>

        {/*
          Two to a row, except the ones that need the width. A text box or a set of options laid out
          half-width beside something else reads as an afterthought.
        */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {form.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={answers[field.key] ?? ""}
              onChange={set(field.key)}
              error={showErrors ? (errors[field.key] ?? null) : null}
            />
          ))}
        </div>

        {/* The honeypot. Hidden from people, irresistible to form-fillers. */}
        <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="website-url">Leave this blank</label>
          <input
            id="website-url"
            name="website-url"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <Button
          className="w-full"
          disabled={pending}
          onClick={() => {
            setTouched(true);
            setError(null);
            // Refused here rather than sent and bounced, so the boxes light up straight away.
            if (Object.keys(errors).length > 0) return;

            startTransition(async () => {
              const result = await submitForm({
                slug: form.slug,
                values: answers,
                website: honeypot,
                elapsedMs: openedAt.current === null ? undefined : Date.now() - openedAt.current,
              });
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setDone(result.data.thankYou);
            });
          }}
        >
          {pending ? "Sending…" : "Send"}
        </Button>

        <p className="text-center text-xs text-subtle">
          We&apos;ll use this to answer you and to keep you posted on the things you&apos;ve asked about. You can
          change that at any time from the link in any email we send.
        </p>
      </CardContent>
    </Card>
  );
}

/** Autofill only works if the box says what it is, and only the four known keys can say. */
const AUTOCOMPLETE: Record<string, string> = {
  name: "name",
  email: "email",
  phone: "tel",
  companyName: "organization",
};

function Field({
  field,
  value,
  onChange,
  error,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  const id = `f-${field.key}`;
  const wide = field.type === "TEXTAREA" || field.type === "CHECKBOX";
  const describedBy = error ? `${id}-error` : undefined;

  if (field.type === "CHECKBOX") {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === "yes"}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <Label htmlFor={id} className="cursor-pointer">
            {field.label}
            {field.required && <Required />}
          </Label>
        </div>
        <FieldError id={`${id}-error`} message={error} />
      </div>
    );
  }

  return (
    <div className={`space-y-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <Label htmlFor={id}>
        {field.label}
        {field.required && <Required />}
      </Label>

      {field.type === "TEXTAREA" ? (
        <Textarea
          id={id}
          rows={4}
          value={value}
          placeholder={field.placeholder ?? undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "SELECT" ? (
        <Select
          id={id}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : "text"}
          value={value}
          placeholder={field.placeholder ?? undefined}
          autoComplete={AUTOCOMPLETE[field.key] ?? "off"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

function Required() {
  return (
    <span className="ml-0.5 text-danger" aria-hidden>
      *
    </span>
  );
}

function FieldError({ id, message }: { id: string; message: string | null }) {
  if (!message) return null;
  // `role="alert"` so a screen reader hears it when it appears, rather than only on the next tab.
  return (
    <p id={id} role="alert" className="text-xs text-danger">
      {message}
    </p>
  );
}
