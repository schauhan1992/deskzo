"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, UserPlus } from "lucide-react";
import { recordCardTap, shareBackFromCard } from "@/actions/card-public";
import { inkOn, type CardQuestion, type DrawnCard } from "@/lib/cards/fields";
import { CardFace } from "@/components/cards/card-face";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * The card's public page, interactive: Save contact first and biggest, the card's links (each tap
 * counted, nothing more), and sharing back underneath — offered, never in the way.
 */
export function PublicCardView({
  handle,
  card,
  color,
  layout,
  logoUrl,
  photoUrl,
  shareBack,
  questions,
  firstName,
}: {
  handle: string;
  card: DrawnCard;
  color: string;
  layout: "CLASSIC" | "CENTRED";
  logoUrl: string | null;
  photoUrl: string | null;
  shareBack: boolean;
  questions: CardQuestion[];
  firstName: string;
}) {
  const ink = inkOn(color);
  return (
    <div className="mx-auto w-full max-w-md space-y-6">
      <CardFace
        card={card}
        color={color}
        layout={layout}
        logoUrl={logoUrl}
        photoUrl={photoUrl}
        onTap={(kind) => {
          void recordCardTap(handle, kind).catch(() => undefined);
        }}
      >
        <a
          href={`/c/${handle}/vcard`}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-base font-semibold shadow-sm"
          style={{ backgroundColor: color, color: ink }}
        >
          <UserPlus className="h-5 w-5" aria-hidden />
          Save contact
        </a>
      </CardFace>
      {shareBack && <ShareBackForm handle={handle} firstName={firstName} questions={questions} />}
    </div>
  );
}

function ShareBackForm({ handle, firstName, questions }: { handle: string; firstName: string; questions: CardQuestion[] }) {
  // Set once the form is on screen: how long it took to fill is one of the two bot checks.
  const opened = useRef<number | null>(null);
  useEffect(() => {
    opened.current = Date.now();
  }, []);
  const [values, setValues] = useState({ name: "", email: "", phone: "", company: "", jobTitle: "", message: "", website: "" });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();
  const set = (key: keyof typeof values) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  if (sent) {
    return (
      <section className="flex items-start gap-3 rounded-2xl border border-line bg-surface px-5 py-4">
        <Check className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
        <p className="text-sm text-text">
          Sent — {firstName} has your details.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-surface px-5 py-5">
      <h2 className="text-base font-semibold text-text">Share your details with {firstName}</h2>
      <p className="mt-1 text-sm text-muted">So {firstName} can get back to you. You don&apos;t need to, to save the card.</p>
      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          start(async () => {
            const result = await shareBackFromCard({ handle, ...values, answers, elapsedMs: opened.current === null ? undefined : Date.now() - opened.current });
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setSent(true);
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="sb-name">Your name</Label>
          <Input id="sb-name" required maxLength={120} autoComplete="name" value={values.name} onChange={set("name")} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sb-email">Email</Label>
            <Input id="sb-email" type="email" maxLength={200} autoComplete="email" value={values.email} onChange={set("email")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-phone">Phone</Label>
            <Input id="sb-phone" type="tel" maxLength={32} autoComplete="tel" value={values.phone} onChange={set("phone")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-company">Company</Label>
            <Input id="sb-company" maxLength={160} autoComplete="organization" value={values.company} onChange={set("company")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-title">Job title</Label>
            <Input id="sb-title" maxLength={80} autoComplete="organization-title" value={values.jobTitle} onChange={set("jobTitle")} />
          </div>
        </div>
        {questions.map((q) => (
          <div key={q.id} className="space-y-1.5">
            <Label htmlFor={`sb-q-${q.id}`}>
              {q.label}
              {!q.required && <span className="font-normal text-subtle"> (optional)</span>}
            </Label>
            <Input
              id={`sb-q-${q.id}`}
              required={q.required}
              maxLength={500}
              value={answers[q.id] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
            />
          </div>
        ))}
        <div className="space-y-1.5">
          <Label htmlFor="sb-message">
            A note <span className="font-normal text-subtle">(optional)</span>
          </Label>
          <Textarea id="sb-message" rows={3} maxLength={1000} value={values.message} onChange={set("message")} />
        </div>
        {/* A real person never sees this, so never fills it in. */}
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label htmlFor="sb-website">Website</label>
          <input id="sb-website" tabIndex={-1} autoComplete="off" value={values.website} onChange={set("website")} />
        </div>
        {error && <p className="text-sm text-danger">{error}</p>}
        <p className="text-xs text-subtle">An email address or a phone number is enough. Only {firstName}&apos;s company sees what you send.</p>
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Sending…" : `Send to ${firstName}`}
        </Button>
      </form>
    </section>
  );
}
