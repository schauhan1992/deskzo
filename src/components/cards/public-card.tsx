"use client";

import { useRef, useState, useTransition } from "react";
import { Phone, Mail, Globe, MapPin, BriefcaseBusiness, MessageCircle, CalendarDays, Smartphone, UserPlus, Check } from "lucide-react";
import type { CardFieldKey, CardLine } from "@/lib/cards/template";
import { contrastColor } from "@/lib/branding";
import { recordCardTap, shareBack } from "@/actions/cards-public";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ActionNotice } from "@/components/ui/action-notice";

const ICONS: Partial<Record<CardFieldKey, typeof Phone>> = {
  workPhone: Phone,
  companyPhone: Phone,
  mobile: Smartphone,
  email: Mail,
  website: Globe,
  address: MapPin,
  branchAddress: MapPin,
  linkedin: BriefcaseBusiness,
  whatsapp: MessageCircle,
  calendar: CalendarDays,
};

export type CardFaceProps = {
  name: string;
  title: string | null;
  about: string;
  photoUrl: string | null;
  lines: CardLine[];
  company: string;
  logoDataUrl: string | null;
  accentColor: string;
  coverColor: string;
};

/**
 * The card itself — cover, logo, photo, name, title and its lines. Shared by the public page and the
 * preview on "My card", so what somebody sees there is what the person they meet will see.
 */
export function CardFace({ face, onTap, saveHref }: { face: CardFaceProps; onTap?: () => void; saveHref?: string | null }) {
  const initials = face.name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const onAccent = contrastColor(face.accentColor);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
      <div className="relative h-24" style={{ backgroundColor: face.coverColor }}>
        {face.logoDataUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a data URL; there is nothing for the image optimiser to fetch
          <img src={face.logoDataUrl} alt={face.company} className="absolute right-3 top-3 h-8 max-w-[45%] rounded bg-white/90 object-contain p-1" />
        )}
      </div>
      <div className="px-5 pb-5">
        <div className="-mt-10 flex items-end gap-3">
          {face.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- served by the card's own photo route
            <img src={face.photoUrl} alt="" className="h-20 w-20 rounded-full border-4 border-surface object-cover" />
          ) : (
            <div
              aria-hidden
              className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-surface text-xl font-semibold"
              style={{ backgroundColor: face.accentColor, color: onAccent }}
            >
              {initials}
            </div>
          )}
        </div>
        <h1 className="mt-3 text-xl font-semibold text-text">{face.name}</h1>
        {(face.title || face.company) && (
          <p className="text-sm text-muted">{[face.title, face.company].filter(Boolean).join(" · ")}</p>
        )}
        {face.about && <p className="mt-2 text-sm text-text">{face.about}</p>}

        {saveHref !== undefined && (
          <a
            href={saveHref ?? undefined}
            aria-disabled={saveHref === null}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-base px-4 py-3 text-base font-semibold"
            style={{ backgroundColor: face.accentColor, color: onAccent }}
          >
            <UserPlus className="h-5 w-5" aria-hidden />
            Save contact
          </a>
        )}

        {face.lines.length > 0 && (
          <ul className="mt-4 divide-y divide-line">
            {face.lines.map((l) => {
              const Icon = ICONS[l.key] ?? Globe;
              const body = (
                <span className="flex items-center gap-3 py-2.5">
                  <Icon className="h-4 w-4 shrink-0" style={{ color: face.accentColor }} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-xs text-subtle">{l.label}</span>
                    <span className="block break-words text-sm text-text">{l.value}</span>
                  </span>
                </span>
              );
              return (
                <li key={l.key}>
                  {l.href ? (
                    <a href={l.href} onClick={onTap} target={l.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" className="block hover:bg-surface-sunken">
                      {body}
                    </a>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The public page: the card, Save contact, and the optional share-back form. */
export function PublicCardView(props: CardFaceProps & { slug: string; questions: string[] }) {
  const { slug, questions, ...face } = props;
  const firstName = face.name.split(/\s+/)[0] ?? face.name;
  // When the form was opened, for the server's "filled in too fast to be a person" check.
  const opened = useRef(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thanked, setThanked] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ name: "", email: "", phone: "", companyName: "", note: "", website: "" });
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ""));

  function tap() {
    void recordCardTap(slug);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const result = await shareBack(slug, { ...form, answers, elapsedMs: Date.now() - opened.current });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setThanked(result.data.firstName);
    });
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <main className="mx-auto max-w-sm space-y-4">
      <CardFace face={face} onTap={tap} saveHref={`/c/${slug}/vcard`} />

      <section className="rounded-xl border border-line bg-surface px-5 py-4">
        {thanked ? (
          <p className="flex items-center gap-2 text-sm text-text">
            <Check className="h-4 w-4 text-success" aria-hidden />
            Thanks, {thanked} — {firstName} has your details.
          </p>
        ) : !open ? (
          <button
            type="button"
            onClick={() => {
              opened.current = Date.now();
              setOpen(true);
            }} className="w-full text-left text-sm font-medium text-text">
            Share your details with {firstName}
            <span className="block text-xs font-normal text-muted">Optional — you don&apos;t need to, to save the card.</span>
          </button>
        ) : (
          <form onSubmit={submit} className="space-y-3" noValidate>
            <p className="text-sm font-medium text-text">Share your details with {firstName}</p>
            <div className="space-y-1.5">
              <Label htmlFor="sb-name">Your name</Label>
              <Input id="sb-name" required autoComplete="name" value={form.name} onChange={set("name")} maxLength={100} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-email">Email</Label>
              <Input id="sb-email" type="email" autoComplete="email" value={form.email} onChange={set("email")} maxLength={200} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-phone">Phone</Label>
              <Input id="sb-phone" type="tel" autoComplete="tel" value={form.phone} onChange={set("phone")} maxLength={32} />
              <p className="text-xs text-subtle">An email or a phone number — either is enough.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sb-company">Company (optional)</Label>
              <Input id="sb-company" autoComplete="organization" value={form.companyName} onChange={set("companyName")} maxLength={120} />
            </div>
            {questions.map((q, i) => (
              <div key={i} className="space-y-1.5">
                <Label htmlFor={`sb-q${i}`}>{q}</Label>
                <Input
                  id={`sb-q${i}`}
                  value={answers[i] ?? ""}
                  maxLength={500}
                  onChange={(e) => setAnswers((a) => a.map((x, j) => (j === i ? e.target.value : x)))}
                />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="sb-note">A note (optional)</Label>
              <Textarea id="sb-note" rows={2} value={form.note} onChange={set("note")} maxLength={1000} />
            </div>
            {/* People never see this; scripts fill it in. */}
            <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
              <label htmlFor="sb-website">Website</label>
              <input id="sb-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={set("website")} />
            </div>
            <div aria-live="polite">{error && <ActionNotice tone="error">{error}</ActionNotice>}</div>
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Sending…" : "Send"}
            </Button>
            <p className="text-xs text-subtle">
              Goes to {firstName} at {face.company || "their company"}, to get back in touch. Nothing else is done with it.
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
