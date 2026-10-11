"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { deleteSignatureTemplate, makeDefaultSignatureTemplate, saveSignatureTemplate } from "@/actions/signature";
import { EMPTY_DETAILS, SIGNATURE_FONTS, SOCIAL_NETWORKS, renderSignature, type SignatureFont } from "@/lib/signatures/render";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

const RECORD = [
  { key: "photo", label: "Photo" },
  { key: "title", label: "Job title" },
  { key: "department", label: "Department" },
  { key: "phone", label: "Work phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Office address" },
] as const;

const LAYOUTS = [
  { key: "CLASSIC", label: "Classic", renders: "classic" },
  { key: "MODERN", label: "Modern", renders: "modern" },
  { key: "STACKED", label: "Stacked", renders: "stacked" },
  { key: "COMPACT", label: "Compact", renders: "compact" },
] as const;

export type SignatureTemplateDraft = {
  id: string | null;
  name: string;
  isDefault: boolean;
  layout: (typeof LAYOUTS)[number]["key"];
  color: string;
  font: SignatureFont;
  shown: string[];
  website: string;
  logoUrl: string;
  social: Record<string, string>;
  ctaLabel: string;
  ctaUrl: string;
  signOff: string;
  disclaimer: string;
  /** People who get it now. */
  people: number;
};

const BLANK: SignatureTemplateDraft = {
  id: null,
  name: "",
  isDefault: false,
  layout: "CLASSIC",
  color: "#1d4ed8",
  font: "arial",
  shown: ["photo", "title", "phone", "email", "address"],
  website: "",
  logoUrl: "",
  social: {},
  ctaLabel: "",
  ctaUrl: "",
  signOff: "",
  disclaimer: "",
  people: 0,
};

/** The company's signature designs — each person's details come from their record. */
export function SignatureTemplates({ templates, company }: { templates: SignatureTemplateDraft[]; company: string }) {
  const router = useRouter();
  const [draft, setDraft] = useState<SignatureTemplateDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (draft) return <Editor initial={draft} company={company} onDone={() => setDraft(null)} />;
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
        <Button type="button" onClick={() => setDraft({ ...BLANK })}>
          <Plus className="h-4 w-4" />
          New template
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {templates.map((t) => (
          <li key={t.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
            <span className="h-10 w-10 shrink-0 rounded-lg" style={{ backgroundColor: t.color }} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 font-medium text-text">
                {t.name}
                {t.isDefault && <Badge tone="brand">Default</Badge>}
              </p>
              <p className="text-xs text-muted">
                {LAYOUTS.find((l) => l.key === t.layout)?.label} · {t.people} {t.people === 1 ? "person" : "people"}
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
        ))}
      </ul>
    </div>
  );
}

function Editor({ initial, company, onDone }: { initial: SignatureTemplateDraft; company: string; onDone: () => void }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof SignatureTemplateDraft>(key: K, value: SignatureTemplateDraft[K]) => setD((p) => ({ ...p, [key]: value }));
  const shown = new Set(d.shown);

  const preview = useMemo(() => {
    const on = new Set(d.shown);
    return renderSignature(
        {
          ...EMPTY_DETAILS,
          name: "Priya Sharma",
          jobTitle: on.has("title") ? "Sales manager" : "",
          department: on.has("department") ? "Sales" : "",
          company: company || "Your company",
          phone: on.has("phone") ? "+91 98765 43210" : "",
          email: on.has("email") ? "priya@yourcompany.com" : "",
          address: on.has("address") ? "The office she works at" : "",
          website: d.website,
          logo: d.logoUrl,
          social: { ...EMPTY_DETAILS.social, ...d.social },
          ctaLabel: d.ctaLabel,
          ctaUrl: d.ctaUrl,
          signOff: d.signOff,
          disclaimer: d.disclaimer,
        },
        { template: LAYOUTS.find((l) => l.key === d.layout)?.renders ?? "classic", color: d.color, font: d.font },
        null,
      );
  }, [d, company]);

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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="st-name">Name</Label>
            <Input id="st-name" maxLength={60} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Sales team" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-layout">Layout</Label>
            <Select id="st-layout" value={d.layout} onChange={(e) => set("layout", e.target.value as SignatureTemplateDraft["layout"])}>
              {LAYOUTS.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </Select>
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
          <h3 className="text-sm font-semibold text-text">The same for everybody</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="st-web">Website</Label>
              <Input id="st-web" maxLength={300} value={d.website} onChange={(e) => set("website", e.target.value)} placeholder="yourcompany.com" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-logo">Logo address</Label>
              <Input id="st-logo" maxLength={500} value={d.logoUrl} onChange={(e) => set("logoUrl", e.target.value)} placeholder="Empty: the logo in Settings → Branding" />
            </div>
            {SOCIAL_NETWORKS.map((n) => (
              <div key={n.key} className="space-y-1.5">
                <Label htmlFor={`st-${n.key}`}>{n.label}</Label>
                <Input id={`st-${n.key}`} maxLength={300} value={d.social[n.key] ?? ""} onChange={(e) => set("social", { ...d.social, [n.key]: e.target.value })} placeholder={`The company's ${n.label}`} />
              </div>
            ))}
            <div className="space-y-1.5">
              <Label htmlFor="st-cta">Button text</Label>
              <Input id="st-cta" maxLength={60} value={d.ctaLabel} onChange={(e) => set("ctaLabel", e.target.value)} placeholder="Book a demo" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-cta-url">Button link</Label>
              <Input id="st-cta-url" maxLength={500} value={d.ctaUrl} onChange={(e) => set("ctaUrl", e.target.value)} placeholder="yourcompany.com/demo" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="st-signoff">Sign-off</Label>
              <Input id="st-signoff" maxLength={60} value={d.signOff} onChange={(e) => set("signOff", e.target.value)} placeholder="Best regards," />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="st-disclaimer">Disclaimer</Label>
            <Textarea id="st-disclaimer" rows={2} maxLength={600} value={d.disclaimer} onChange={(e) => set("disclaimer", e.target.value)} />
          </div>
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
          {/* Built by renderSignature, which escapes everything and allows only safe links. */}
          <div dangerouslySetInnerHTML={{ __html: preview }} />
        </Card>
      </div>
    </div>
  );
}
