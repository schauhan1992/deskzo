"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { CalendarDays, CheckCircle2, MapPin, Star } from "lucide-react";
import type { getForm, getInvitedForm } from "@/actions/marketing-public";
import { submitForm } from "@/actions/marketing-public";
import {
  MANDATORY_KEYS,
  joinPicks,
  splitPicks,
  validateAnswers,
  type Answers,
  type FormField,
} from "@/lib/marketing/form-fields";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type PublicForm = NonNullable<Awaited<ReturnType<typeof getForm>>>;
type InvitedForm = NonNullable<Awaited<ReturnType<typeof getInvitedForm>>>;
export type RenderableForm = PublicForm | InvitedForm;

/**
 * A form, as the person filling it in sees it — on the public link, on a personal invitation, and
 * in the builder's preview, which is this same component with sending switched off.
 *
 * The questions come from the form's own spec rather than from this file. Validation runs here and
 * again in `submitForm`, through the same `validateAnswers`. The copy here is only so somebody sees
 * which box is wrong before they send; the server's copy is the one that decides.
 *
 * Two anti-spam measures, both invisible to a real person: a honeypot field a browser never shows
 * and a human never fills, and the time the form was on screen. A submission that arrives in under
 * two seconds was not typed. Neither taxes the people you actually want, which is the problem with
 * a CAPTCHA.
 *
 * An event adds one question above the rest — are you coming — and somebody who says no is asked
 * only who they are. Making a person who has declined answer the dietary question is how an RSVP
 * form gets abandoned instead of answered.
 */
export function InboundForm({ form, preview = false }: { form: RenderableForm; preview?: boolean }) {
  const invitation = "invitation" in form ? form.invitation : null;
  const event = form.category === "EVENT";

  // Read in an effect rather than during render: the clock is not a pure value, and the React
  // compiler is right to refuse it. Null until mounted, which also means a submission from a
  // client that never ran the effect simply skips the timing check rather than failing it.
  const openedAt = useRef<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);

  const [answers, setAnswers] = useState<Answers>(() => {
    const start = Object.fromEntries(form.fields.map((f) => [f.key, ""])) as Answers;
    if (invitation) {
      Object.assign(start, invitation.previous ?? {}, {
        name: invitation.previous?.name || invitation.name,
        email: invitation.email,
        ...(form.fields.some((f) => f.key === "companyName") ? { companyName: invitation.companyName } : {}),
        // Only what they typed last time. The number on file is ours, and an invitation forwarded to
        // a colleague must not hand it to them.
        phone: invitation.previous?.phone ?? "",
      });
    }
    return start;
  });
  const [attending, setAttending] = useState<boolean | null>(invitation?.attending ?? null);
  const [honeypot, setHoneypot] = useState("");

  const set = (key: string) => (value: string) => setAnswers((a) => ({ ...a, [key]: value }));

  useEffect(() => {
    openedAt.current = Date.now();
  }, []);

  const declining = event && attending === false;
  // Somebody saying no is asked who they are and nothing else.
  const shown = declining ? form.fields.filter((f) => (MANDATORY_KEYS as string[]).includes(f.key)) : form.fields;
  const errors = validateAnswers(form.fields, answers, { onlyMandatory: declining });
  const needsRsvp = event && attending === null;
  // Fixed by the invitation: the address it went to and the company it was for.
  const locked = new Set(invitation ? ["email", "companyName"] : []);

  if (done) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="space-y-3 py-12 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
          <h1 className="text-lg font-semibold text-text">Thank you.</h1>
          <p className="text-sm text-muted">{done}</p>
          {invitation && (
            <p className="text-xs text-subtle">If anything changes, open this same link again and update your answer.</p>
          )}
        </CardContent>
      </Card>
    );
  }

  const header = (
    <div className="space-y-2">
      <h1 className="text-xl font-semibold text-text">{form.headline ?? form.name}</h1>
      {form.intro && <p className="whitespace-pre-line text-sm text-muted">{form.intro}</p>}
      {event && (form.eventWhen || form.venue) && (
        <div className="mt-3 space-y-1.5 rounded-lg border border-line bg-surface-sunken px-3.5 py-3 text-sm text-text">
          {form.eventWhen && (
            <div className="flex items-start gap-2">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span>{form.eventWhen}</span>
            </div>
          )}
          {form.venue && (
            <div className="flex items-start gap-2">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
              <span className="whitespace-pre-line">{form.venue}</span>
            </div>
          )}
        </div>
      )}
      {invitation && (
        <p className="text-xs text-subtle">
          Invitation for {invitation.name}, {invitation.companyName}.
          {invitation.previous && " You've answered before — changing anything below updates that answer."}
        </p>
      )}
    </div>
  );

  if (form.closedMessage && !preview) {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardContent className="space-y-4 py-8">
          {header}
          <p className="rounded-lg border border-line bg-surface-sunken px-3.5 py-3 text-sm text-muted">{form.closedMessage}</p>
        </CardContent>
      </Card>
    );
  }

  // Full, and this person is not already holding one of the seats.
  const noSeat = event && form.full && invitation?.attending !== true;

  return (
    <Card className="mx-auto max-w-2xl">
      <CardContent className="space-y-6 py-6">
        {header}

        {event && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">
              Will you be there?
              <span className="ml-0.5 text-danger" aria-hidden>
                *
              </span>
            </legend>
            <div className="grid grid-cols-2 gap-2">
              {[
                { value: true, label: "Yes, I'll be there" },
                { value: false, label: "Sorry, I can't make it" },
              ].map((option) => {
                const selected = attending === option.value;
                const disabled = option.value && noSeat;
                return (
                  <button
                    key={String(option.value)}
                    type="button"
                    disabled={disabled}
                    aria-pressed={selected}
                    onClick={() => setAttending(option.value)}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors",
                      selected ? "border-brand bg-brand-subtle text-brand" : "border-line text-text hover:bg-surface-sunken",
                      disabled && "cursor-not-allowed opacity-50",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
            {noSeat && <p className="text-xs text-warning">Every seat has been taken. You can still let us know you can&apos;t come.</p>}
            {touched && needsRsvp && (
              <p role="alert" className="text-xs text-danger">
                Let us know whether you can come.
              </p>
            )}
          </fieldset>
        )}

        {/*
          Two to a row, except the ones that need the width. A text box or a set of options laid out
          half-width beside something else reads as an afterthought.
        */}
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
          {shown.map((field) =>
            field.type === "HEADING" ? (
              <div key={field.key} className="border-t border-line pt-4 sm:col-span-2 first:border-0 first:pt-0">
                {field.label && <h2 className="text-sm font-semibold text-text">{field.label}</h2>}
                {field.help && <p className="mt-0.5 text-xs text-muted">{field.help}</p>}
              </div>
            ) : (
              <Field
                key={field.key}
                field={field}
                value={answers[field.key] ?? ""}
                onChange={set(field.key)}
                readOnly={locked.has(field.key)}
                error={touched ? (errors[field.key] ?? null) : null}
              />
            ),
          )}
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

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <Button
          className="w-full"
          disabled={pending || preview}
          onClick={() => {
            setTouched(true);
            setError(null);
            // Refused here rather than sent and bounced, so the boxes light up straight away.
            if (needsRsvp || Object.keys(errors).length > 0) return;

            startTransition(async () => {
              const result = await submitForm({
                slug: form.slug,
                values: answers,
                attending: event ? attending! : undefined,
                inviteToken: invitation?.token,
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
          {preview ? "Send (preview)" : pending ? "Sending…" : invitation?.previous ? "Update my answer" : event ? "Send my RSVP" : "Send"}
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

const WIDE: FormField["type"][] = ["TEXTAREA", "CHECKBOX", "RADIO", "MULTISELECT", "RATING"];

function Field({
  field,
  value,
  onChange,
  error,
  readOnly,
}: {
  field: FormField;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  readOnly: boolean;
}) {
  const id = `f-${field.key}`;
  const describedBy = [field.help ? `${id}-help` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  const invalid = error ? true : undefined;

  if (field.type === "CHECKBOX") {
    return (
      <div className="space-y-1.5 sm:col-span-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id={id}
            checked={value === "yes"}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(e) => onChange(e.target.checked ? "yes" : "")}
          />
          <Label htmlFor={id} className="cursor-pointer">
            {field.label}
            {field.required && <Required />}
          </Label>
        </div>
        <Help id={id} text={field.help} />
        <FieldError id={`${id}-error`} message={error} />
      </div>
    );
  }

  // A group of options is a fieldset with a legend, so a screen reader announces the question with
  // each choice rather than a bare "Microsoft 365, radio button, 1 of 4".
  if (field.type === "RADIO" || field.type === "MULTISELECT" || field.type === "RATING") {
    const picks = field.type === "MULTISELECT" ? splitPicks(value) : [value];
    const options = field.type === "RATING" ? ["1", "2", "3", "4", "5"] : field.options;
    return (
      <fieldset className="space-y-1.5 sm:col-span-2" aria-describedby={describedBy} aria-invalid={invalid}>
        <legend className="text-sm font-medium text-text">
          {field.label}
          {field.required && <Required />}
        </legend>
        <Help id={id} text={field.help} />
        {field.type === "RATING" ? (
          <div className="flex gap-1.5">
            {options.map((option) => {
              const on = Number(value) >= Number(option);
              return (
                <button
                  key={option}
                  type="button"
                  aria-label={`${option} out of 5`}
                  aria-pressed={value === option}
                  onClick={() => onChange(value === option ? "" : option)}
                  className="rounded-md p-1 hover:bg-surface-sunken"
                >
                  <Star className={cn("h-6 w-6", on ? "fill-warning text-warning" : "text-subtle")} aria-hidden />
                </button>
              );
            })}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {options.map((option, index) => {
              const checked = picks.includes(option);
              const optionId = `${id}-${index}`;
              return (
                <label
                  key={option}
                  htmlFor={optionId}
                  className={cn(
                    "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm",
                    checked ? "border-brand bg-brand-subtle/60 text-text" : "border-line text-text hover:bg-surface-sunken",
                  )}
                >
                  <input
                    id={optionId}
                    type={field.type === "MULTISELECT" ? "checkbox" : "radio"}
                    name={id}
                    className="mt-0.5 accent-[var(--color-brand)]"
                    checked={checked}
                    onChange={(e) => {
                      if (field.type === "RADIO") return onChange(option);
                      const next = e.target.checked ? [...picks, option] : picks.filter((p) => p !== option);
                      // Kept in the order they are offered, not the order they were ticked.
                      onChange(joinPicks(field.options.filter((o) => next.includes(o))));
                    }}
                  />
                  <span>{option}</span>
                </label>
              );
            })}
          </div>
        )}
        <FieldError id={`${id}-error`} message={error} />
      </fieldset>
    );
  }

  return (
    <div className={cn("space-y-1.5", WIDE.includes(field.type) && "sm:col-span-2")}>
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
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : field.type === "SELECT" ? (
        <Select id={id} value={value} aria-invalid={invalid} aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)}>
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
          type={
            field.type === "EMAIL" ? "email" : field.type === "PHONE" ? "tel" : field.type === "DATE" ? "date" : "text"
          }
          // A number is typed as text: "1,20,000" is how people here write one, and a number box
          // refuses the commas.
          inputMode={field.type === "NUMBER" ? "decimal" : undefined}
          value={value}
          readOnly={readOnly}
          placeholder={field.placeholder ?? undefined}
          autoComplete={AUTOCOMPLETE[field.key] ?? "off"}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={readOnly ? "bg-surface-sunken text-muted" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      <Help id={id} text={field.help} />
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

function Help({ id, text }: { id: string; text: string | null }) {
  if (!text) return null;
  return (
    <p id={`${id}-help`} className="text-xs text-subtle">
      {text}
    </p>
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
