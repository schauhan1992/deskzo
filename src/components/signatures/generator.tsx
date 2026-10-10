"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Lock } from "lucide-react";
import {
  DEFAULT_ACCENT,
  SAMPLE_SIGNATURE,
  SOCIALS,
  renderSignatureHtml,
  renderSignatureText,
  type PremiumTeaser,
  type SignatureData,
  type SignatureLayout,
  type SocialKey,
} from "@/lib/signatures/render";
import { buttonClasses } from "@/components/site/ui";
import { SignatureFrame, copyRichHtml } from "@/components/signatures/frame";

type Form = Required<Pick<SignatureData, "name" | "title" | "company" | "phone" | "mobile" | "email" | "website" | "address" | "logoUrl">> & {
  accent: string;
  socials: Record<SocialKey, string>;
};

const EMPTY: Form = {
  name: "",
  title: "",
  company: "",
  phone: "",
  mobile: "",
  email: "",
  website: "",
  address: "",
  logoUrl: "",
  accent: DEFAULT_ACCENT,
  socials: { linkedin: "", x: "", instagram: "", facebook: "", youtube: "" },
};

/** What the previews show: the visitor's details once they start typing, an example until then. */
function dataOf(form: Form): SignatureData {
  const typed = Object.entries(form).some(([k, v]) => k !== "accent" && k !== "socials" && typeof v === "string" && v.trim());
  if (!typed) return { ...SAMPLE_SIGNATURE, accent: form.accent };
  return { ...form, name: form.name.trim() || "Your name" };
}

/** Base64url of UTF-8 JSON — what the preview image route reads. */
function encode(d: SignatureData): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...d, logoUrl: undefined, photoUrl: undefined }));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The public generator: the form, the four free templates live, and the eight premium ones as
 * watermarked pictures of the visitor's own signature — "see it, then upgrade to use it".
 */
export function SignatureGenerator({
  freeLayouts,
  premium,
  madeWithHref,
  previewPath,
  upgradeHref,
  demoHref,
}: {
  freeLayouts: SignatureLayout[];
  premium: PremiumTeaser[];
  madeWithHref: string;
  previewPath: string;
  upgradeHref: string;
  demoHref: string;
}) {
  const [form, setForm] = useState<Form>(EMPTY);
  const [selected, setSelected] = useState<string>(freeLayouts[0]!.key);
  const [premiumOpen, setPremiumOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState<"rich" | "html" | null>(null);
  const data = useMemo(() => dataOf(form), [form]);
  // The pictures follow the typing, a beat behind, so each keystroke isn't eight image requests.
  const [imageData, setImageData] = useState(() => encode(data));
  useEffect(() => {
    const t = setTimeout(() => setImageData(encode(data)), 600);
    return () => clearTimeout(t);
  }, [data]);

  const madeWith = { href: madeWithHref, label: "Made with Deskzo — free email signatures" };
  const layout = freeLayouts.find((l) => l.key === selected) ?? freeLayouts[0]!;
  const html = renderSignatureHtml(layout, data, { madeWith });

  async function copy(kind: "rich" | "html") {
    const ok = kind === "rich" ? await copyRichHtml(html, renderSignatureText(data)) : await navigator.clipboard?.writeText(html).then(() => true, () => false);
    if (ok) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 2500);
    }
  }

  const set = (k: keyof Omit<Form, "socials">) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const field = (k: keyof Omit<Form, "socials" | "accent">, label: string, opts: { type?: string; placeholder?: string; hint?: string } = {}) => (
    <label className="block space-y-1 text-sm">
      <span className="font-medium text-text">{label}</span>
      <input
        type={opts.type ?? "text"}
        value={form[k]}
        onChange={set(k)}
        placeholder={opts.placeholder}
        maxLength={k === "logoUrl" ? 2000 : 200}
        className="h-9 w-full rounded-base border border-line bg-surface px-3 text-text placeholder:text-subtle focus:border-brand focus:outline-none"
      />
      {opts.hint && <span className="block text-xs text-subtle">{opts.hint}</span>}
    </label>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      <form className="space-y-4" onSubmit={(e) => e.preventDefault()} aria-label="Your details">
        {field("name", "Name", { placeholder: "Priya Sharma" })}
        {field("title", "Job title", { placeholder: "Head of Sales" })}
        {field("company", "Company", { placeholder: "Acme Industries" })}
        <div className="grid grid-cols-2 gap-3">
          {field("phone", "Phone", { type: "tel" })}
          {field("mobile", "Mobile", { type: "tel" })}
        </div>
        {field("email", "Email", { type: "email" })}
        {field("website", "Website", { placeholder: "www.example.com" })}
        {field("address", "Address")}
        {field("logoUrl", "Logo image address", { placeholder: "https://…/logo.png", hint: "A link to your logo online. Email can't carry an uploaded file, so it has to live on the web." })}
        <label className="flex items-center gap-3 text-sm">
          <span className="font-medium text-text">Colour</span>
          <input type="color" value={form.accent} onChange={set("accent")} className="h-9 w-14 rounded-base border border-line bg-surface" />
        </label>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-text">Social profiles</legend>
          {SOCIALS.map((s) => (
            <input
              key={s.key}
              aria-label={s.label}
              placeholder={`${s.label} link`}
              value={form.socials[s.key]}
              maxLength={200}
              onChange={(e) => setForm((f) => ({ ...f, socials: { ...f.socials, [s.key]: e.target.value } }))}
              className="h-9 w-full rounded-base border border-line bg-surface px-3 text-sm text-text placeholder:text-subtle focus:border-brand focus:outline-none"
            />
          ))}
        </fieldset>
      </form>

      <div className="space-y-8">
        <section aria-labelledby="sig-free">
          <h2 id="sig-free" className="text-lg font-semibold text-text">
            Free templates
          </h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {freeLayouts.map((l) => (
              <button
                key={l.key}
                type="button"
                onClick={() => setSelected(l.key)}
                aria-pressed={selected === l.key}
                className={`rounded-xl border bg-surface p-3 text-left transition ${selected === l.key ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong"}`}
              >
                <span className="block text-sm font-medium text-text">{l.name}</span>
                <span className="block text-xs text-muted">{l.blurb}</span>
                <span className="pointer-events-none mt-2 block overflow-hidden rounded border border-line bg-white">
                  <SignatureFrame html={renderSignatureHtml(l, data)} height={150} scale={0.62} title={`${l.name} template`} />
                </span>
              </button>
            ))}
          </div>

          <div className="mt-5 rounded-xl border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="mr-auto text-sm font-semibold text-text">Your signature — {layout.name}</h3>
              <button type="button" className={buttonClasses("primary")} onClick={() => copy("rich")}>
                {copied === "rich" ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
                {copied === "rich" ? "Copied" : "Copy signature"}
              </button>
              <button type="button" className={buttonClasses("secondary")} onClick={() => copy("html")}>
                {copied === "html" ? "Copied" : "Copy HTML"}
              </button>
            </div>
            <div className="mt-3 overflow-hidden rounded border border-line bg-white">
              <SignatureFrame html={html} height={layout.arrangement === "inline" ? 110 : 230} title="Your signature" />
            </div>
            <p className="mt-3 text-xs text-muted">
              <strong>Gmail:</strong> Settings → See all settings → Signature → paste. <strong>Outlook:</strong> Settings → Mail → Compose and reply → paste.{" "}
              <strong>Apple Mail:</strong> Settings → Signatures → paste, and untick &ldquo;Always match my default message font&rdquo;.
            </p>
          </div>
        </section>

        <section aria-labelledby="sig-premium">
          <div className="flex flex-wrap items-end gap-3">
            <div className="mr-auto">
              <h2 id="sig-premium" className="text-lg font-semibold text-text">
                Premium templates
              </h2>
              <p className="text-sm text-muted">Your signature in each, to look at. Using them comes with Deskzo Signatures — kept in step for your whole team, with no &ldquo;Made with&rdquo; line.</p>
            </div>
            <a href={upgradeHref} className={buttonClasses("primary")}>
              See plans
            </a>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {premium.map((p) => (
              <button key={p.key} type="button" onClick={() => setPremiumOpen(p.key)} className="rounded-xl border border-line bg-surface p-3 text-left hover:border-line-strong">
                <span className="flex items-center gap-1.5 text-sm font-medium text-text">
                  <Lock className="h-3.5 w-3.5 text-brand" aria-hidden />
                  {p.name}
                  <span className="ml-auto rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">Premium</span>
                </span>
                <span className="block text-xs text-muted">{p.blurb}</span>
                {/* eslint-disable-next-line @next/next/no-img-element -- a server-drawn, watermarked PNG */}
                <img src={`${previewPath}?t=${encodeURIComponent(p.key)}&d=${imageData}`} alt={`${p.name} template, watermarked preview`} width={640} height={300} loading="lazy" className="mt-2 w-full rounded border border-line bg-white" />
              </button>
            ))}
          </div>
        </section>
      </div>

      {premiumOpen && (
        <div role="dialog" aria-modal="true" aria-labelledby="premium-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setPremiumOpen(null)}>
          <div className="w-full max-w-xl rounded-xl bg-surface p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 id="premium-title" className="text-lg font-semibold text-text">
              {premium.find((p) => p.key === premiumOpen)?.name} is a premium template
            </h2>
            {/* eslint-disable-next-line @next/next/no-img-element -- a server-drawn, watermarked PNG */}
            <img src={`${previewPath}?t=${encodeURIComponent(premiumOpen)}&d=${imageData}`} alt="Watermarked preview" width={640} height={300} className="mt-3 w-full rounded border border-line bg-white" />
            <p className="mt-3 text-sm text-muted">
              Premium templates come with Deskzo Signatures, and with Deskzo One. Your team&apos;s signatures fill themselves from each person&apos;s record — photo, title, phone, digital card — with your logo and colours locked.
            </p>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button type="button" className={buttonClasses("ghost")} onClick={() => setPremiumOpen(null)}>
                Keep the free one
              </button>
              <a href={demoHref} className={buttonClasses("secondary")}>
                Book a demo
              </a>
              <a href={upgradeHref} className={buttonClasses("primary")}>
                See plans
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
