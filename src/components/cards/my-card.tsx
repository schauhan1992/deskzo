"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Check, Download, Nfc, Smartphone } from "lucide-react";
import type { MyCard } from "@/actions/cards";
import { updateMyCard } from "@/actions/cards";
import type { CardFieldKey } from "@/lib/cards/template";
import { CardFace } from "@/components/cards/public-card";
import { Card, CardContent, Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

type CardData = NonNullable<MyCard["card"]>;

/** "My card": the preview, sharing it, changing what the template lets you, its numbers, and your contacts. */
export function MyCardView({ data, card }: { data: MyCard; card: CardData }) {
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [own, setOwn] = useState<Record<string, string>>(() => Object.fromEntries(card.editable.typeable.map((f) => [f.key, f.value])));
  const [hidden, setHidden] = useState<CardFieldKey[]>(() => card.editable.hideable.filter((f) => f.hidden).map((f) => f.key));
  const [about, setAbout] = useState(card.about);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, start] = useTransition();

  function copy() {
    void navigator.clipboard?.writeText(card.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function save() {
    setError(null);
    setSaved(false);
    start(async () => {
      const result = await updateMyCard({ own, hidden, about });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  const editable = card.editable.hideable.length > 0 || card.editable.typeable.length > 0;

  return (
    <div className="animate-fade-rise space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold text-text">My card</h1>
        {card.active ? <Badge tone="green">Live</Badge> : <Badge tone="amber">Switched off</Badge>}
        <span className="text-xs text-subtle">Template: {card.templateName}</span>
      </div>
      {!card.active && (
        <ActionNotice tone="info">Your card is switched off. Its link tells people you&apos;re no longer with the company; HR or an admin can switch it back on.</ActionNotice>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="space-y-4">
          <CardFace
            face={{
              name: card.name,
              title: card.title,
              about,
              photoUrl: card.photoUrl,
              lines: card.lines,
              company: data.company.name,
              logoDataUrl: card.showLogo ? data.company.logoDataUrl : null,
              accentColor: card.accentColor,
              coverColor: card.coverColor,
            }}
            saveHref={null}
          />
          <p className="text-xs text-subtle">The preview shows what you last saved.</p>
        </div>

        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-3 py-4">
              <h2 className="text-sm font-semibold text-text">Share it</h2>
              <div className="flex flex-wrap items-start gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element -- a QR code rendered on the server as a data URL */}
                <img src={card.qrDataUrl} alt={`QR code for ${card.url}`} className="h-40 w-40 rounded border border-line bg-white p-1" />
                <div className="min-w-0 flex-1 space-y-2 text-sm">
                  <p className="break-all font-medium text-text">{card.url}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={copy}>
                      {copied ? <Check className="mr-1 h-4 w-4" aria-hidden /> : <Copy className="mr-1 h-4 w-4" aria-hidden />}
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                    <a href={card.qrDataUrl} download={`${card.slug}-qr.png`} className="inline-flex items-center rounded-base border border-line px-3 py-1.5 text-sm text-text hover:bg-surface-sunken">
                      <Download className="mr-1 h-4 w-4" aria-hidden />
                      QR code
                    </a>
                    <a href={card.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-base border border-line px-3 py-1.5 text-sm text-text hover:bg-surface-sunken">
                      Open card
                    </a>
                  </div>
                  <p className="flex gap-2 text-xs text-muted">
                    <Smartphone className="h-4 w-4 shrink-0" aria-hidden />
                    Open this page on your phone and add it to your home screen: your QR is then one tap away.
                  </p>
                  <p className="flex gap-2 text-xs text-muted">
                    <Nfc className="h-4 w-4 shrink-0" aria-hidden />
                    Write the link to any NFC card, sticker or keyring with a free NFC app. The link never changes.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4">
              <h2 className="text-sm font-semibold text-text">How it&apos;s doing</h2>
              <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {(
                  [
                    ["Views", "views"],
                    ["Saves", "saves"],
                    ["Link taps", "taps"],
                    ["Shared back", "shared"],
                  ] as const
                ).map(([label, key]) => (
                  <div key={key} className="rounded-base border border-line px-3 py-2">
                    <dt className="text-xs text-subtle">{label}</dt>
                    <dd className="text-lg font-semibold text-text">{card.week[key]}</dd>
                    <dd className="text-xs text-muted">{card.allTime[key]} all time</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-2 text-xs text-subtle">The big numbers are the last 7 days.</p>
            </CardContent>
          </Card>

          {editable && (
            <Card>
              <CardContent className="space-y-3 py-4">
                <h2 className="text-sm font-semibold text-text">Your details</h2>
                <p className="text-xs text-muted">Your name, title, work phone and email come from your record, so they stay right. Ask HR to change those.</p>
                <div className="space-y-1.5">
                  <Label htmlFor="card-about">A line about you</Label>
                  <Textarea id="card-about" rows={2} maxLength={280} value={about} onChange={(e) => setAbout(e.target.value)} />
                </div>
                {card.editable.typeable.map((f) => (
                  <div key={f.key} className="space-y-1.5">
                    <Label htmlFor={`card-${f.key}`}>{f.label}</Label>
                    <Input
                      id={`card-${f.key}`}
                      value={own[f.key] ?? ""}
                      placeholder={f.placeholder}
                      maxLength={200}
                      onChange={(e) => setOwn((o) => ({ ...o, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
                {card.editable.hideable.length > 0 && (
                  <fieldset className="space-y-1.5">
                    <legend className="text-sm font-medium text-text">Show on my card</legend>
                    {card.editable.hideable.map((f) => (
                      <label key={f.key} className="flex items-center gap-2 text-sm text-text">
                        <input
                          type="checkbox"
                          checked={!hidden.includes(f.key)}
                          onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((k) => k !== f.key) : [...h, f.key]))}
                        />
                        {f.label}
                      </label>
                    ))}
                  </fieldset>
                )}
                <div aria-live="polite">
                  {error && <ActionNotice tone="error">{error}</ActionNotice>}
                  {!error && saved && <ActionNotice tone="success">Saved. Your card shows it now.</ActionNotice>}
                </div>
                <div className="flex justify-end">
                  <Button type="button" size="sm" onClick={save} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      <Card>
        <CardContent className="py-4">
          <h2 className="text-sm font-semibold text-text">People who shared their details</h2>
          {data.contacts.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nobody yet. People who scan your card can share theirs back; they land here, and as your leads when they give a company.</p>
          ) : (
            <ContactsTable contacts={data.contacts} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export function ContactsTable({ contacts, showHolder }: { contacts: (MyCard["contacts"][number] & { cardholder?: string })[]; showHolder?: boolean }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-subtle">
            <th className="py-2 pr-3 font-medium">Name</th>
            <th className="py-2 pr-3 font-medium">Reach them</th>
            <th className="py-2 pr-3 font-medium">Company</th>
            {showHolder && <th className="py-2 pr-3 font-medium">Card</th>}
            <th className="py-2 pr-3 font-medium">When</th>
            <th className="py-2 font-medium">Lead</th>
          </tr>
        </thead>
        <tbody>
          {contacts.map((c) => (
            <tr key={c.id} className="border-b border-line align-top">
              <td className="py-2 pr-3 text-text">
                {c.name}
                {c.answers.map((a) => (
                  <span key={a.question} className="block text-xs text-muted">
                    {a.question}: {a.answer}
                  </span>
                ))}
              </td>
              <td className="py-2 pr-3 text-text">
                {c.email && (
                  <a href={`mailto:${c.email}`} className="block hover:underline">
                    {c.email}
                  </a>
                )}
                {c.phone && (
                  <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`} className="block hover:underline">
                    {c.phone}
                  </a>
                )}
              </td>
              <td className="py-2 pr-3 text-text">{c.companyName ?? "—"}</td>
              {showHolder && <td className="py-2 pr-3 text-text">{c.cardholder}</td>}
              <td className="py-2 pr-3 text-muted">{new Date(c.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</td>
              <td className="py-2 text-muted">{c.leadId ? "Lead made" : "No company given"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
