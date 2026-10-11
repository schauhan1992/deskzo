"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { deleteSignatureTemplate, makeDefaultSignatureTemplate, saveSignatureTemplate } from "@/actions/signature";
import { EMPTY_DETAILS, SIGNATURE_FONTS, SOCIAL_NETWORKS, imageNote, linkNote, type SignatureBannerSpec, type SignatureDetails, type SignatureFont } from "@/lib/signatures/render";
import { ALL_SIGNATURE_LAYOUTS, STORED_LAYOUTS, renderAnySignature, type StoredLayout } from "@/lib/signatures/premium";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const RECORD = [
  { key: "photo", label: "Photo" },
  { key: "title", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "phone", label: "Work phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Office address" },
] as const;

/** Every layout, as the template stores it — the premium six are Deskzo Signatures' own. */
const LAYOUTS = (Object.keys(STORED_LAYOUTS) as StoredLayout[]).map((key) => {
  const layout = ALL_SIGNATURE_LAYOUTS.find((l) => l.key === STORED_LAYOUTS[key])!;
  return { key, renders: layout.key, label: layout.label, hint: layout.hint, premium: layout.premium };
});

export type SignatureTemplateDraft = {
  id: string | null;
  name: string;
  isDefault: boolean;
  layout: StoredLayout;
  color: string;
  font: SignatureFont;
  shown: string[];
  website: string;
  logoUrl: string;
  logoLink: string;
  social: Record<string, string>;
  ctaLabel: string;
  ctaUrl: string;
  signOff: string;
  disclaimer: string;
  /** People who get it now. */
  people: number;
  /** The banner its signatures carry today, for the preview. */
  banner: SignatureBannerSpec | null;
};

const BLANK: Omit<SignatureTemplateDraft, "banner"> = {
  id: null,
  name: "",
  isDefault: false,
  layout: "CLASSIC",
  color: "#1d4ed8",
  font: "arial",
  shown: ["photo", "title", "phone", "email", "address"],
  website: "",
  logoUrl: "",
  logoLink: "",
  social: {},
  ctaLabel: "",
  ctaUrl: "",
  signOff: "",
  disclaimer: "",
  people: 0,
};

type Brand = {
  /** Branding's logo, used when a template gives none — null when there is none, or mail programs can't show it. */
  logo: string | null;
  /** Branding has a logo, but an SVG or WebP one Outlook and Gmail don't show. */
  logoUnusable: boolean;
};

/** The company's signature designs — each person's details come from their record. */
export function SignatureTemplates({
  templates,
  company,
  brand,
  everybodyBanner,
}: {
  templates: SignatureTemplateDraft[];
  company: string;
  brand: Brand;
  /** The banner a new template's signatures would carry. */
  everybodyBanner: SignatureBannerSpec | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<SignatureTemplateDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (draft) return <Editor initial={draft} company={company} brand={brand} onDone={() => setDraft(null)} />;
  const act = (work: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) setError(r.error ?? "That didn't work.");
      else router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" onClick={() => setDraft({ ...BLANK, banner: everybodyBanner })}>
          <Plus className="h-4 w-4" />
          New template
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => {
          const layout = LAYOUTS.find((l) => l.key === t.layout);
          return (
            <li key={t.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
              <span className="h-10 w-10 shrink-0 rounded-lg" style={{ backgroundColor: t.color }} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                  {t.name}
                  {t.isDefault && <Badge tone="brand">Default</Badge>}
                </p>
                <p className="text-xs text-muted">
                  {layout?.label}
                  {layout?.premium ? " (premium)" : ""} · {t.people} {t.people === 1 ? "person" : "people"}
                </p>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(t)}>
                  Edit
                </Button>
                {!t.isDefault && (
                  <>
                    <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => act(() => makeDefaultSignatureTemplate(t.id!))}>
                      Make default
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${t.name}`}
                      className="text-danger hover:bg-danger-bg hover:text-danger"
                      disabled={pending}
                      onClick={() => act(() => deleteSignatureTemplate(t.id!))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A person to show the template with — the fields the template shows, nothing else. */
function sample(d: SignatureTemplateDraft, company: string, brand: Brand): SignatureDetails {
  const on = new Set(d.shown);
  return {
    ...EMPTY_DETAILS,
    name: "Priya Sharma",
    jobTitle: on.has("title") ? "Sales manager" : "",
    department: on.has("department") ? "Sales" : "",
    company: company || "Your company",
    phone: on.has("phone") ? "+91 98765 43210" : "",
    email: on.has("email") ? "priya@yourcompany.com" : "",
    address: on.has("address") ? "The office she works at" : "",
    website: d.website,
    logo: d.logoUrl || brand.logo || "",
    logoLink: d.logoLink,
    social: { ...EMPTY_DETAILS.social, ...d.social },
    ctaLabel: d.ctaLabel,
    ctaUrl: d.ctaUrl,
    signOff: d.signOff,
    disclaimer: d.disclaimer,
    banner: d.banner,
  };
}

function Field({ id, label, note, children }: { id: string; label: string; note?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {note && <p className="text-xs text-danger">{note}</p>}
    </div>
  );
}

function Editor({ initial, company, brand, onDone }: { initial: SignatureTemplateDraft; company: string; brand: Brand; onDone: () => void }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof SignatureTemplateDraft>(key: K, value: SignatureTemplateDraft[K]) => setD((p) => ({ ...p, [key]: value }));
  const shown = new Set(d.shown);
  const renders = LAYOUTS.find((l) => l.key === d.layout)?.renders ?? "classic";

  const preview = useMemo(() => renderAnySignature(sample(d, company, brand), { template: renders, color: d.color, font: d.font }, null), [d, company, brand, renders]);
  // Each layout drawn small, in this template's colour, font and logo, without the banner and disclaimer.
  const thumbs = useMemo(() => {
    const person = { ...sample(d, company, brand), banner: null, disclaimer: "", signOff: "" };
    return new Map(LAYOUTS.map((l) => [l.key, renderAnySignature(person, { template: l.renders, color: d.color, font: d.font }, null)]));
  }, [d, company, brand]);

  function save() {
    setError(null);
    start(async () => {
      const r = await saveSignatureTemplate({ ...d, shown: d.shown });
      if (!r.ok) return setError(r.error);
      router.refresh();
      onDone();
    });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-text">Layout</h3>
          <p className="flex items-center gap-1 text-xs text-muted">
            <Sparkles className="h-3.5 w-3.5 text-brand" aria-hidden />
            Premium layouts come with Deskzo Signatures — the free generator has the first four.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {LAYOUTS.map((l) => (
            <button
              key={l.key}
              type="button"
              onClick={() => set("layout", l.key)}
              aria-pressed={d.layout === l.key}
              className={cn(
                "flex flex-col overflow-hidden rounded-xl border text-left transition-colors",
                d.layout === l.key ? "border-brand ring-2 ring-brand/30" : "border-line hover:border-line-strong",
              )}
            >
              <span className="relative block h-28 overflow-hidden bg-white p-2">
                {/* Built by renderAnySignature, which escapes everything and allows only safe links. */}
                <span className="pointer-events-none block w-[200%] origin-top-left scale-50" dangerouslySetInnerHTML={{ __html: thumbs.get(l.key) ?? "" }} />
              </span>
              <span className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-text">{l.label}</span>
                  <span className="block truncate text-xs text-muted">{l.hint}</span>
                </span>
                {l.premium && <Badge tone="brand">Premium</Badge>}
              </span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="st-name">Name</Label>
              <Input id="st-name" maxLength={60} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Sales team" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-font">Font</Label>
              <Select id="st-font" value={d.font} onChange={(e) => set("font", e.target.value as SignatureFont)}>
                {(Object.keys(SIGNATURE_FONTS) as SignatureFont[]).map((f) => (
                  <option key={f} value={f}>
                    {SIGNATURE_FONTS[f].label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-color">Colour</Label>
              <div className="flex gap-2">
                <input id="st-color" type="color" value={d.color} onChange={(e) => set("color", e.target.value)} className="h-9 w-12 cursor-pointer rounded-base border border-line bg-surface" />
                <Input aria-label="Colour as hex" maxLength={7} value={d.color} onChange={(e) => set("color", e.target.value)} />
              </div>
            </div>
          </div>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-text">From each person&apos;s record</h3>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {RECORD.map((f) => (
                <label key={f.key} className="flex items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={shown.has(f.key)} onChange={(e) => set("shown", e.target.checked ? [...d.shown, f.key] : d.shown.filter((k) => k !== f.key))} />
                  {f.label}
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-text">Logo</h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="st-logo" label="Logo address (https://)" note={d.logoUrl ? imageNote(d.logoUrl) : null}>
                <Input id="st-logo" maxLength={500} value={d.logoUrl} onChange={(e) => set("logoUrl", e.target.value)} placeholder="Empty: the logo in Settings → Branding" />
              </Field>
              <Field id="st-logo-link" label="Logo links to (https://)" note={linkNote(d.logoLink)}>
                <Input id="st-logo-link" maxLength={500} value={d.logoLink} onChange={(e) => set("logoLink", e.target.value)} placeholder="Empty: the website" />
              </Field>
            </div>
            {!d.logoUrl && brand.logoUnusable && (
              <p className="text-xs text-warning">
                The logo in Settings → Branding is an SVG or WebP picture, which Outlook and Gmail don&apos;t show. Give a PNG or JPEG logo&apos;s https:// address here.
              </p>
            )}
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-text">The same for everybody</h3>
            <p className="text-xs text-muted">Every link is https:// only — an http:// one is refused, so nothing in a signature travels unencrypted.</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field id="st-web" label="Website" note={linkNote(d.website)}>
                <Input id="st-web" maxLength={300} value={d.website} onChange={(e) => set("website", e.target.value)} placeholder="yourcompany.com" />
              </Field>
              {SOCIAL_NETWORKS.map((n) => (
                <Field key={n.key} id={`st-${n.key}`} label={n.label} note={linkNote(d.social[n.key] ?? "")}>
                  <Input id={`st-${n.key}`} maxLength={300} value={d.social[n.key] ?? ""} onChange={(e) => set("social", { ...d.social, [n.key]: e.target.value })} placeholder={`The company's ${n.label}`} />
                </Field>
              ))}
              <Field id="st-cta" label="Button text">
                <Input id="st-cta" maxLength={60} value={d.ctaLabel} onChange={(e) => set("ctaLabel", e.target.value)} placeholder="Book a demo" />
              </Field>
              <Field id="st-cta-url" label="Button link" note={linkNote(d.ctaUrl)}>
                <Input id="st-cta-url" maxLength={500} value={d.ctaUrl} onChange={(e) => set("ctaUrl", e.target.value)} placeholder="yourcompany.com/demo" />
              </Field>
              <Field id="st-signoff" label="Sign-off">
                <Input id="st-signoff" maxLength={60} value={d.signOff} onChange={(e) => set("signOff", e.target.value)} placeholder="Best regards," />
              </Field>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-disclaimer">Disclaimer</Label>
              <Textarea id="st-disclaimer" rows={2} maxLength={600} value={d.disclaimer} onChange={(e) => set("disclaimer", e.target.value)} />
            </div>
            <p className="text-xs text-muted">Banners under the signature are set once for the company, on the Banners tab.</p>
          </section>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {error && <p className="mr-auto text-sm text-danger">{error}</p>}
            <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : d.id && d.people > 0 ? `Save — ${d.people} ${d.people === 1 ? "signature changes" : "signatures change"}` : "Save"}
            </Button>
          </div>
        </div>
        <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
          <p className="text-xs font-medium uppercase tracking-wide text-subtle">Preview</p>
          <Card className="overflow-x-auto bg-white px-5 py-5 text-[#333333]">
            {/* Built by renderAnySignature, which escapes everything and allows only safe links. */}
            <div dangerouslySetInnerHTML={{ __html: preview }} />
          </Card>
          {d.banner && <p className="text-xs text-subtle">With the banner its signatures carry today.</p>}
        </div>
      </div>
    </div>
  );
}
