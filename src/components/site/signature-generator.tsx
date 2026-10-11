"use client";

import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ClipboardCopy, Code2, Download, ImagePlus } from "lucide-react";
import {
  EMPTY_DETAILS,
  GMAIL_LIMIT,
  SIGNATURE_FONTS,
  SIGNATURE_TEMPLATES,
  SOCIAL_NETWORKS,
  imageNote,
  renderSignature,
  safeColor,
  safeEmail,
  safePhone,
  safeUrl,
  signatureText,
  type SignatureDetails,
  type SignatureFont,
  type SignatureStyle,
  type SignatureTemplate,
} from "@/lib/signatures/render";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const COLORS = ["#1d4ed8", "#0f766e", "#7c3aed", "#be123c", "#c2410c", "#111827"];

const noSubscription = () => () => {};

const STEPS: { app: string; steps: string[] }[] = [
  { app: "Gmail", steps: ["Open Gmail, then Settings (the gear) → See all settings.", "Under General → Signature, choose Create new and name it.", "Click in the box and paste (Ctrl+V or ⌘V).", "Choose it as the default for new emails and replies, then Save changes at the bottom."] },
  { app: "Outlook (new, and on the web)", steps: ["Open Settings → Account → Signatures.", "Choose + New signature and name it.", "Paste into the box, then choose it for new messages and replies, and Save."] },
  { app: "Outlook for Windows (classic)", steps: ["Open File → Options → Mail → Signatures.", "Choose New, name it, and paste into the box.", "Pick it for new messages and replies, then OK."] },
  { app: "Apple Mail", steps: ["Open Mail → Settings → Signatures.", "Choose the account, then + to add one.", "Untick “Always match my default message font”, then paste."] },
];

/**
 * The free email signature generator. Everything happens in this browser: nothing typed here is sent
 * anywhere or kept. The signature itself is src/lib/signatures/render.ts — the same HTML the paid
 * product will push into a whole company's mailboxes.
 */
export function SignatureGenerator({
  siteName,
  fallbackHref,
  privacyNote,
}: {
  siteName: string;
  /** Where "Made with …" links to, until the browser says which page this is. */
  fallbackHref: string;
  privacyNote?: string;
}) {
  const [d, setD] = useState<SignatureDetails>(EMPTY_DETAILS);
  const [style, setStyle] = useState<SignatureStyle>({ template: "classic", color: COLORS[0]!, font: "arial" });
  const [copied, setCopied] = useState<"rich" | "html" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  // This page's own address, for the credit — the browser knows it; the server render uses the site's.
  const pageHref = useSyncExternalStore(noSubscription, () => `${window.location.origin}${window.location.pathname}`, () => fallbackHref);
  const madeWith = useMemo(() => ({ href: pageHref, name: siteName }), [pageHref, siteName]);

  const html = useMemo(() => renderSignature(d, style, madeWith), [d, style, madeWith]);
  const set = <K extends keyof SignatureDetails>(key: K) => (value: SignatureDetails[K]) => setD((prev) => ({ ...prev, [key]: value }));
  const tooLong = html.length > GMAIL_LIMIT;

  function flash(kind: "rich" | "html") {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 2500);
  }

  /** The preview selected and copied as it is — for a browser without the clipboard API, or refusing it. */
  function copySelection(): boolean {
    const node = preview.current;
    const selection = window.getSelection();
    if (!node || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(node);
    selection.removeAllRanges();
    selection.addRange(range);
    const done = document.execCommand("copy");
    selection.removeAllRanges();
    return done;
  }

  async function copyRich() {
    setProblem(null);
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("no clipboard API");
      await navigator.clipboard.write([
        new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([signatureText(d, madeWith)], { type: "text/plain" }) }),
      ]);
      flash("rich");
    } catch {
      if (copySelection()) flash("rich");
      else setProblem("This browser wouldn't copy it. Select the signature in the preview and copy it yourself.");
    }
  }

  async function copyHtml() {
    setProblem(null);
    try {
      await navigator.clipboard.writeText(html);
      flash("html");
    } catch {
      setProblem("This browser wouldn't copy the HTML. Download it instead.");
    }
  }

  function download() {
    const file = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email signature</title></head><body>${html}</body></html>`;
    const url = URL.createObjectURL(new Blob([file], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "email-signature.htm";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  const urlProblem = (value: string) => (value.trim() && !safeUrl(value) ? "That isn't a web address." : null);

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="space-y-6">
        <Group title="Look">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SIGNATURE_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setStyle((s) => ({ ...s, template: t.key as SignatureTemplate }))}
                className={cn(
                  "rounded-base border px-3 py-2 text-left text-sm transition-colors",
                  style.template === t.key ? "border-brand bg-brand-subtle text-text" : "border-line bg-surface text-muted hover:border-line-strong",
                )}
                aria-pressed={style.template === t.key}
              >
                <span className="block font-medium text-text">{t.label}</span>
                <span className="block text-xs">{t.hint}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="sig-color">Colour</Label>
              <div className="flex items-center gap-2">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Colour ${c}`}
                    onClick={() => setStyle((s) => ({ ...s, color: c }))}
                    className={cn("h-7 w-7 rounded-full border-2", safeColor(style.color) === c ? "border-text" : "border-transparent")}
                    style={{ backgroundColor: c }}
                  />
                ))}
                <input
                  id="sig-color"
                  type="color"
                  value={safeColor(style.color)}
                  onChange={(e) => setStyle((s) => ({ ...s, color: e.target.value }))}
                  className="h-8 w-10 cursor-pointer rounded-base border border-line bg-surface"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sig-font">Font</Label>
              <Select id="sig-font" value={style.font} onChange={(e) => setStyle((s) => ({ ...s, font: e.target.value as SignatureFont }))}>
                {(Object.keys(SIGNATURE_FONTS) as SignatureFont[]).map((f) => (
                  <option key={f} value={f}>
                    {SIGNATURE_FONTS[f].label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </Group>

        <Group title="You">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sig-name" label="Name" value={d.name} onChange={set("name")} max={80} autoComplete="name" />
            <Field id="sig-title" label="Job title" value={d.jobTitle} onChange={set("jobTitle")} max={80} autoComplete="organization-title" />
            <Field id="sig-department" label="Department" value={d.department} onChange={set("department")} max={80} />
            <Field id="sig-company" label="Company" value={d.company} onChange={set("company")} max={100} autoComplete="organization" />
            <Field id="sig-phone" label="Phone" value={d.phone} onChange={set("phone")} max={32} type="tel" problem={d.phone.trim() && !safePhone(d.phone) ? "That isn't a phone number." : null} />
            <Field id="sig-mobile" label="Mobile" value={d.mobile} onChange={set("mobile")} max={32} type="tel" problem={d.mobile.trim() && !safePhone(d.mobile) ? "That isn't a phone number." : null} />
            <Field id="sig-email" label="Email" value={d.email} onChange={set("email")} max={200} type="email" problem={d.email.trim() && !safeEmail(d.email) ? "That isn't an email address." : null} />
            <Field id="sig-website" label="Website" value={d.website} onChange={set("website")} max={300} placeholder="yourcompany.com" problem={urlProblem(d.website)} />
          </div>
          <Field id="sig-address" label="Address" value={d.address} onChange={set("address")} max={200} />
        </Group>

        <Group title="Pictures">
          <ImageField id="sig-photo" label="Your photo" value={d.photo} onChange={set("photo")} kind="photo" />
          <ImageField id="sig-logo" label="Company logo" value={d.logo} onChange={set("logo")} kind="logo" />
        </Group>

        <Group title="Social profiles">
          <div className="grid gap-3 sm:grid-cols-2">
            {SOCIAL_NETWORKS.map((n) => (
              <Field
                key={n.key}
                id={`sig-${n.key}`}
                label={n.label}
                value={d.social[n.key]}
                onChange={(v) => setD((prev) => ({ ...prev, social: { ...prev.social, [n.key]: v } }))}
                max={300}
                placeholder={`${n.label.toLowerCase()}.com/…`}
                problem={urlProblem(d.social[n.key])}
              />
            ))}
          </div>
        </Group>

        <Group title="Extras">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="sig-signoff" label="Sign-off" value={d.signOff} onChange={set("signOff")} max={60} placeholder="Best regards," />
            <div />
            <Field id="sig-cta-label" label="Button text" value={d.ctaLabel} onChange={set("ctaLabel")} max={60} placeholder="Book a meeting" />
            <Field id="sig-cta-url" label="Button link" value={d.ctaUrl} onChange={set("ctaUrl")} max={300} placeholder="calendar link" problem={urlProblem(d.ctaUrl)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sig-disclaimer">Disclaimer</Label>
            <Textarea id="sig-disclaimer" rows={2} maxLength={600} value={d.disclaimer} onChange={(e) => set("disclaimer")(e.target.value)} placeholder="This email and anything attached to it is confidential…" />
          </div>
        </Group>
      </div>

      <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <div className="overflow-hidden rounded-2xl border border-line shadow-sm">
          <div className="flex items-center gap-1.5 border-b border-line bg-surface-sunken px-4 py-2.5" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="ml-3 text-xs text-muted">New message</span>
          </div>
          {/* Mail is read on white, whatever this page's theme — so is the preview. */}
          <div className="bg-white px-5 py-6 text-[#333333]">
            <p className="mb-4 text-sm text-[#666666]">Hi Priya, thanks for your time today…</p>
            {/* Built by renderSignature, which escapes everything typed and allows only safe links. */}
            <div ref={preview} className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={copyRich}>
            {copied === "rich" ? <Check className="h-4 w-4" /> : <ClipboardCopy className="h-4 w-4" />}
            {copied === "rich" ? "Copied — now paste it" : "Copy signature"}
          </Button>
          <Button type="button" variant="secondary" onClick={copyHtml}>
            {copied === "html" ? <Check className="h-4 w-4" /> : <Code2 className="h-4 w-4" />}
            {copied === "html" ? "HTML copied" : "Copy HTML"}
          </Button>
          <Button type="button" variant="secondary" onClick={download}>
            <Download className="h-4 w-4" />
            Download
          </Button>
        </div>
        {problem && <p className="text-sm text-danger">{problem}</p>}
        <p className={cn("text-xs", tooLong ? "text-warning" : "text-subtle")}>
          {tooLong
            ? `${html.length.toLocaleString("en-IN")} characters — more than Gmail's ${GMAIL_LIMIT.toLocaleString("en-IN")}. A picked image is usually why: use links to your images instead.`
            : `${html.length.toLocaleString("en-IN")} of Gmail's ${GMAIL_LIMIT.toLocaleString("en-IN")} characters.`}
        </p>

        <div className="rounded-2xl border border-line bg-surface">
          <h3 className="border-b border-line px-4 py-3 text-sm font-semibold text-text">Add it to your email</h3>
          {STEPS.map((s) => (
            <details key={s.app} className="group border-b border-line last:border-b-0">
              <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-text marker:hidden">{s.app}</summary>
              <ol className="list-decimal space-y-1 px-4 pb-4 pl-9 text-sm text-muted">
                {s.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </details>
          ))}
        </div>
        {privacyNote && <p className="text-xs text-subtle">{privacyNote}</p>}
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3 rounded-2xl border border-line bg-surface p-5">
      <legend className="px-1 text-sm font-semibold text-text">{title}</legend>
      {children}
    </fieldset>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  max,
  type = "text",
  placeholder,
  autoComplete,
  problem,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
  problem?: string | null;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={problem ? true : undefined}
        aria-describedby={problem ? `${id}-problem` : undefined}
      />
      {problem && (
        <p id={`${id}-problem`} className="text-xs text-warning">
          {problem} It&apos;s left out until it is.
        </p>
      )}
    </div>
  );
}

/**
 * A picture by its address, or picked from this computer — shrunk here first (a photo to 160 pixels
 * square, a logo to 240 wide), because the whole picture travels inside the signature.
 */
function ImageField({ id, label, value, onChange, kind }: { id: string; label: string; value: string; onChange: (v: string) => void; kind: "photo" | "logo" }) {
  const file = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const picked = value.startsWith("data:");
  const note = error ?? imageNote(value);

  function choose(f: File) {
    setError(null);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) {
      setError("Choose a PNG, JPEG, GIF or WebP picture.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return setError("This browser couldn't read the picture.");
        if (kind === "photo") {
          const side = Math.min(image.width, image.height);
          canvas.width = 160;
          canvas.height = 160;
          ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 160, 160);
          onChange(canvas.toDataURL("image/jpeg", 0.85));
        } else {
          const scale = Math.min(1, 240 / image.width);
          canvas.width = Math.round(image.width * scale);
          canvas.height = Math.round(image.height * scale);
          ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
          onChange(canvas.toDataURL("image/png"));
        }
      };
      image.onerror = () => setError("That picture couldn't be read.");
      image.src = String(reader.result);
    };
    reader.readAsDataURL(f);
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={picked ? "Picked from this computer" : value}
          readOnly={picked}
          placeholder="https://yourcompany.com/images/logo.png"
          maxLength={500}
          onChange={(e) => onChange(e.target.value)}
          aria-describedby={note ? `${id}-note` : undefined}
        />
        {picked ? (
          <Button type="button" variant="secondary" onClick={() => onChange("")}>
            Remove
          </Button>
        ) : (
          <Button type="button" variant="secondary" onClick={() => file.current?.click()}>
            <ImagePlus className="h-4 w-4" />
            Choose
          </Button>
        )}
      </div>
      {note && (
        <p id={`${id}-note`} className="text-xs text-warning">
          {note}
        </p>
      )}
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) choose(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}
