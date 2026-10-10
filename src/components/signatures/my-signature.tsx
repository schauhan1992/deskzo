"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Lock } from "lucide-react";
import type { MySignature } from "@/actions/signatures";
import { saveSignatureSettings, updateMySignature } from "@/actions/signatures";
import { SOCIALS, type SocialKey } from "@/lib/signatures/render";
import { SignatureFrame, copyRichHtml, copyText } from "@/components/signatures/frame";
import { Card, CardContent, Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

export function MySignatureView({ data }: { data: MySignature }) {
  const router = useRouter();
  const [copied, setCopied] = useState<"rich" | "html" | null>(null);
  const [mobile, setMobile] = useState(data.mobile);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  async function copy(kind: "rich" | "html") {
    const ok = kind === "rich" ? await copyRichHtml(data.html, data.text) : await copyText(data.html);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 2500);
    }
  }

  function save(templateKey: string | undefined, nextMobile = mobile) {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await updateMySignature({ templateKey, mobile: nextMobile });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Saved. Copy it again into your mail to use it.");
      router.refresh();
    });
  }

  return (
    <div className="animate-fade-rise space-y-4">
      <h1 className="text-xl font-semibold text-text">Email signature</h1>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mr-auto text-sm font-semibold text-text">Your signature</h2>
            <Button type="button" size="sm" onClick={() => copy("rich")}>
              {copied === "rich" ? <Check className="mr-1 h-4 w-4" aria-hidden /> : <Copy className="mr-1 h-4 w-4" aria-hidden />}
              {copied === "rich" ? "Copied" : "Copy signature"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => copy("html")}>
              {copied === "html" ? "Copied" : "Copy HTML"}
            </Button>
          </div>
          <div className="overflow-hidden rounded-base border border-line bg-white">
            <SignatureFrame html={data.html} height={360} title="Your signature" />
          </div>
          <p className="text-xs text-muted">
            <strong>Gmail:</strong> Settings → See all settings → Signature → paste. <strong>Outlook:</strong> Settings → Mail → Compose and reply → paste.{" "}
            <strong>Apple Mail:</strong> Settings → Signatures → paste.
          </p>
          <p className="text-xs text-subtle">
            Your name, title, work phone, email and office come from your record — ask HR to change them.
            {data.hasPhoto ? " Your profile photo is included." : " Add a profile photo to include one."}
            {data.hasCard ? " It links your digital card." : ""}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="sig-mobile">Mobile on your signature (optional)</Label>
              <Input id="sig-mobile" type="tel" value={mobile} maxLength={32} onChange={(e) => setMobile(e.target.value)} />
            </div>
            <Button type="button" size="sm" variant="secondary" disabled={pending || mobile === data.mobile} onClick={() => save(undefined)}>
              Save
            </Button>
          </div>
          <div aria-live="polite">
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            {!error && notice && <ActionNotice tone="success">{notice}</ActionNotice>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h2 className="text-sm font-semibold text-text">Template</h2>
          {data.locked ? (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted">
              <Lock className="h-4 w-4" aria-hidden /> Your company uses one signature for everybody.
            </p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.choices.map((c) => (
                <div
                  key={c.key}
                  role="button"
                  tabIndex={0}
                  aria-disabled={pending}
                  onClick={() => !pending && save(c.key)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !pending) {
                      e.preventDefault();
                      save(c.key);
                    }
                  }}
                  aria-pressed={c.key === data.selectedKey}
                  className={`rounded-base border p-3 text-left ${c.key === data.selectedKey ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong"}`}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-text">
                    {c.name}
                    {c.tier === "premium" && <Badge tone="blue">Premium</Badge>}
                  </span>
                  <span className="block text-xs text-muted">{c.blurb}</span>
                  <span className="pointer-events-none mt-2 block overflow-hidden rounded border border-line bg-white">
                    <SignatureFrame html={c.html} height={140} scale={0.6} title={`${c.name} template`} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {data.settings && <CompanySettings settings={data.settings} templates={data.allTemplates} hasLogo={data.hasLogo} />}
    </div>
  );
}

function CompanySettings({ settings, templates, hasLogo }: { settings: NonNullable<MySignature["settings"]>; templates: MySignature["allTemplates"]; hasLogo: boolean }) {
  const router = useRouter();
  const [s, setS] = useState({ ...settings, website: settings.website ?? "", disclaimer: settings.disclaimer ?? "", bannerImageUrl: settings.bannerImageUrl ?? "", bannerLink: settings.bannerLink ?? "" });
  const [socials, setSocials] = useState<Record<string, string>>(() => Object.fromEntries(SOCIALS.map((x) => [x.key, settings.socials[x.key as SocialKey] ?? ""])));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    setNotice(null);
    start(async () => {
      const result = await saveSignatureSettings({ ...s, socials });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("Saved. Everybody's signature uses it now; they copy it again into their mail.");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardContent className="space-y-4 py-4">
        <h2 className="text-sm font-semibold text-text">Company signature</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="cs-template">Template</Label>
            <Select id="cs-template" value={s.templateKey} onChange={(e) => setS({ ...s, templateKey: e.target.value })}>
              {templates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                  {c.tier === "premium" ? " (premium)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-accent">Colour</Label>
            <Input id="cs-accent" type="color" value={s.accentColor} onChange={(e) => setS({ ...s, accentColor: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-website">Website</Label>
            <Input id="cs-website" value={s.website} maxLength={200} onChange={(e) => setS({ ...s, website: e.target.value })} placeholder="www.example.com" />
          </div>
        </div>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={s.lockTemplate} onChange={(e) => setS({ ...s, lockTemplate: e.target.checked })} />
            Everybody uses this template (they can&apos;t pick their own)
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={s.showPhoto} onChange={(e) => setS({ ...s, showPhoto: e.target.checked })} />
            Show people&apos;s profile photos, where the template has one
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={s.showCard} onChange={(e) => setS({ ...s, showCard: e.target.checked })} />
            Link each person&apos;s digital card, when they have one
          </label>
        </div>
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="mb-1 text-sm font-medium text-text">Company social profiles</legend>
          {SOCIALS.map((x) => (
            <Input key={x.key} aria-label={x.label} placeholder={`${x.label} link`} value={socials[x.key] ?? ""} maxLength={200} onChange={(e) => setSocials((o) => ({ ...o, [x.key]: e.target.value }))} />
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cs-banner">Banner image address</Label>
            <Input id="cs-banner" value={s.bannerImageUrl} maxLength={2000} onChange={(e) => setS({ ...s, bannerImageUrl: e.target.value })} placeholder="https://…/offer.png" />
            <p className="text-xs text-subtle">Shown by the Campaign and Legal templates. 480 pixels wide works everywhere.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cs-banner-link">Banner links to</Label>
            <Input id="cs-banner-link" value={s.bannerLink} maxLength={2000} onChange={(e) => setS({ ...s, bannerLink: e.target.value })} placeholder="https://…" />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cs-disclaimer">Disclaimer</Label>
          <Textarea id="cs-disclaimer" rows={2} maxLength={600} value={s.disclaimer} onChange={(e) => setS({ ...s, disclaimer: e.target.value })} />
          <p className="text-xs text-subtle">Shown by the Legal template.</p>
        </div>
        {!hasLogo && <p className="text-xs text-subtle">No logo yet: set the letterhead logo in Settings → Organisation, and the templates with a logo show it.</p>}
        <div aria-live="polite">
          {error && <ActionNotice tone="error">{error}</ActionNotice>}
          {!error && notice && <ActionNotice tone="success">{notice}</ActionNotice>}
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save company signature"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
