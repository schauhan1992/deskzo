"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Trash2, Upload } from "lucide-react";
import type { Organisation } from "@/lib/organisation";
import { removeLetterheadLogo, updateLetterhead, uploadLetterheadLogo } from "@/actions/organisation";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";

/**
 * The paper HR letters print on.
 *
 * It sits in organisation settings rather than in branding because it is the same kind of fact as
 * the GSTIN — who the company is on paper — and because the branding page is about the software's
 * appearance, which is a different question that happens to involve a logo.
 */
export function LetterheadManager({
  organisation,
  appLogoDataUrl,
}: {
  organisation: Organisation;
  appLogoDataUrl: string | null;
}) {
  const router = useRouter();
  const logoInput = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [form, setForm] = useState({
    letterNumberPrefix: organisation.letterNumberPrefix,
    letterSignatoryName: organisation.letterSignatoryName ?? "",
    letterSignatoryTitle: organisation.letterSignatoryTitle ?? "",
    letterheadFooter: organisation.letterheadFooter ?? "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setSaved(false);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  function pickLogo(file: File) {
    const reader = new FileReader();
    reader.onload = () => run(() => uploadLetterheadLogo(String(reader.result)));
    reader.readAsDataURL(file);
  }

  const shownLogo = organisation.letterheadLogoDataUrl || appLogoDataUrl;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Letterhead</CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted">
          What appears around every HR letter — offers, appointments, experience and relieving certificates. The
          wording inside a letter is frozen when it is drafted; the letterhead is read fresh each time it prints, so a
          company that moves office gets its new address on a reprint.
        </p>

        <div className="space-y-2">
          <Label>Logo on letters</Label>
          <div className="flex flex-wrap items-center gap-3">
            {shownLogo ? (
              <span className="flex h-14 items-center rounded-base border border-line bg-white px-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL already in the payload */}
                <img src={shownLogo} alt="" className="max-h-10 w-auto object-contain" />
              </span>
            ) : (
              <span className="grid h-14 w-28 place-items-center rounded-base border border-dashed border-line text-xs text-subtle">
                No logo
              </span>
            )}
            <input
              ref={logoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) pickLogo(file);
                e.target.value = "";
              }}
            />
            <Button type="button" variant="secondary" size="sm" onClick={() => logoInput.current?.click()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {organisation.letterheadLogoDataUrl ? "Replace" : "Upload"}
            </Button>
            {organisation.letterheadLogoDataUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => run(() => removeLetterheadLogo())}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-subtle">
            {organisation.letterheadLogoDataUrl
              ? "PNG, JPEG, WebP or SVG, up to 256KB."
              : "Falling back to the app logo. Upload one here if the employer's mark differs from the software's."}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="prefix">Letter number prefix</Label>
            <Input id="prefix" value={form.letterNumberPrefix} onChange={set("letterNumberPrefix")} className="uppercase" />
            <p className="text-xs text-subtle">
              Reference numbers read {form.letterNumberPrefix.toUpperCase() || "WRF"}/APPT/
              {new Date().getFullYear()}/001. Changing it only affects letters drafted from now on — the numbers
              already quoted to people stay as they were.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signatory">Letters signed by</Label>
            <Input
              id="signatory"
              value={form.letterSignatoryName}
              onChange={set("letterSignatoryName")}
              placeholder="Leave blank to use whoever drafts it"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="signatoryTitle">Their title</Label>
            <Input
              id="signatoryTitle"
              value={form.letterSignatoryTitle}
              onChange={set("letterSignatoryTitle")}
              placeholder="Head — Human Resources"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="footer">Footer</Label>
            <Textarea
              id="footer"
              rows={2}
              value={form.letterheadFooter}
              onChange={set("letterheadFooter")}
              placeholder="Registered office: … · CIN: … · www.example.com"
            />
            <p className="text-xs text-subtle">The fine print along the bottom of the page.</p>
          </div>
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={pending} onClick={() => run(() => updateLetterhead(form), () => setSaved(true))}>
            {pending ? "Saving…" : "Save letterhead"}
          </Button>
          {saved && <span className="text-sm text-success">Saved.</span>}
          <a
            href="/people/letters"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-brand hover:underline"
          >
            See issued letters
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
