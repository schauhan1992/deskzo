"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImagePlus, Pause, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { removeSignatureBanner, saveSignatureBanner, setSignatureBannerPaused } from "@/actions/signature";
import { BANNER_WIDTH, imageNote, linkNote } from "@/lib/signatures/render";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type BannerView = {
  id: string;
  name: string;
  /** Where the app shows the picture from: the upload's own address, or the https address given. */
  imageSrc: string;
  imageUrl: string | null;
  linkUrl: string;
  altText: string;
  width: number;
  startsOn: string | null;
  endsOn: string | null;
  paused: boolean;
  templateIds: string[];
  state: "live" | "scheduled" | "ended" | "paused";
  /** Clicks on it in the last 30 days, while clicks are counted. */
  clicks: number;
};

const STATE: Record<BannerView["state"], { tone: "green" | "amber" | "default" | "red"; label: string }> = {
  live: { tone: "green", label: "Live" },
  scheduled: { tone: "amber", label: "Scheduled" },
  ended: { tone: "default", label: "Ended" },
  paused: { tone: "default", label: "Paused" },
};

/** Uploaded pictures: what every mail program shows, 1 MB at most (src/lib/signatures/banners.ts). */
const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/gif"];
const UPLOAD_MAX = 1024 * 1024;

/** A typed day (YYYY-MM-DD) as people read it — the day itself, whatever the zone. */
function day(value: string | null): string {
  return value ? new Date(`${value}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }) : "";
}

function when(b: Pick<BannerView, "startsOn" | "endsOn">): string {
  if (b.startsOn && b.endsOn) return `${day(b.startsOn)} – ${day(b.endsOn)}`;
  if (b.startsOn) return `From ${day(b.startsOn)}`;
  if (b.endsOn) return `Until ${day(b.endsOn)}`;
  return "No end date";
}

type Draft = {
  id: string | null;
  name: string;
  mode: "keep" | "upload" | "url";
  dataUrl: string;
  url: string;
  /** The current picture, when changing a banner. */
  currentSrc: string | null;
  linkUrl: string;
  altText: string;
  width: number;
  startsOn: string;
  endsOn: string;
  everybody: boolean;
  templateIds: string[];
  paused: boolean;
};

const NEW: Draft = {
  id: null,
  name: "",
  mode: "upload",
  dataUrl: "",
  url: "",
  currentSrc: null,
  linkUrl: "",
  altText: "",
  width: BANNER_WIDTH.default,
  startsOn: "",
  endsOn: "",
  everybody: true,
  templateIds: [],
  paused: false,
};

/**
 * Banners under the signature, for the whole company: a picture (uploaded, or an https address), where
 * it links to, when it runs, and whose signatures carry it. Set here by whoever manages signatures;
 * nobody else can change or remove it from their own.
 */
export function SignatureBanners({
  banners,
  templates,
  sampleHtml,
  counting,
}: {
  banners: BannerView[];
  templates: { id: string; name: string }[];
  sampleHtml: string;
  /** Whether clicks are counted (Clicks tab). */
  counting: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (work: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) setError(r.error ?? "That didn't work.");
      else router.refresh();
    });

  if (draft) return <Editor initial={draft} templates={templates} sampleHtml={sampleHtml} onDone={() => setDraft(null)} />;
  const templateName = (id: string) => templates.find((t) => t.id === id)?.name ?? "(a deleted template)";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted">A banner goes under the signature of everybody it is meant for, on its days. One banner per signature: one meant for a template wins over one for everybody.</p>
        <Button type="button" className="ml-auto" onClick={() => setDraft({ ...NEW })}>
          <Plus className="h-4 w-4" />
          New banner
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      {banners.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted">No banners yet. Add one to put an event, an offer or an award under everybody&apos;s signature.</Card>
      ) : (
        <ul className="space-y-3">
          {banners.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-4 rounded-xl border border-line bg-surface p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- the banner exactly as mail programs fetch it */}
              <img src={b.imageSrc} alt={b.altText} className="h-14 w-auto max-w-[14rem] rounded border border-line bg-white object-contain" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 font-medium text-text">
                  {b.name}
                  <Badge tone={STATE[b.state].tone}>{STATE[b.state].label}</Badge>
                </p>
                <p className="text-xs text-muted">
                  {when(b)} · {b.templateIds.length ? b.templateIds.map(templateName).join(", ") : "Everybody"}
                  {b.linkUrl ? ` · links to ${b.linkUrl.replace(/^https:\/\//, "").replace(/\/$/, "")}` : " · no link"}
                </p>
                {counting && b.linkUrl && (
                  <Link href={`/signatures/manage?tab=clicks&item=BANNER:${b.id}`} className="text-xs text-brand hover:underline">
                    {b.clicks} {b.clicks === 1 ? "click" : "clicks"} in 30 days
                  </Link>
                )}
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setDraft({
                      id: b.id,
                      name: b.name,
                      mode: "keep",
                      dataUrl: "",
                      url: b.imageUrl ?? "",
                      currentSrc: b.imageSrc,
                      linkUrl: b.linkUrl,
                      altText: b.altText,
                      width: b.width,
                      startsOn: b.startsOn ?? "",
                      endsOn: b.endsOn ?? "",
                      everybody: b.templateIds.length === 0,
                      templateIds: b.templateIds,
                      paused: b.paused,
                    })
                  }
                >
                  Edit
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => act(() => setSignatureBannerPaused(b.id, !b.paused))}>
                  {b.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                  {b.paused ? "Start" : "Pause"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${b.name}`}
                  title="Remove — emails already sent keep its picture and link"
                  className="text-danger hover:bg-danger-bg hover:text-danger"
                  disabled={pending}
                  onClick={() => act(() => removeSignatureBanner(b.id))}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Editor({ initial, templates, sampleHtml, onDone }: { initial: Draft; templates: { id: string; name: string }[]; sampleHtml: string; onDone: () => void }) {
  const router = useRouter();
  const [d, setD] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const file = useRef<HTMLInputElement | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setD((p) => ({ ...p, [key]: value }));

  const shownSrc = d.mode === "upload" ? d.dataUrl : d.mode === "url" ? d.url.trim() : d.currentSrc;
  const width = Math.min(BANNER_WIDTH.max, Math.max(BANNER_WIDTH.min, Math.round(d.width) || BANNER_WIDTH.default));

  function pick(f: File | undefined) {
    setError(null);
    if (!f) return;
    if (!UPLOAD_TYPES.includes(f.type)) return setError("A banner is a PNG, JPEG or GIF picture — mail programs don't all show other kinds.");
    if (f.size > UPLOAD_MAX) return setError("The picture is over 1 MB. Banners travel in every email — make it smaller (a few hundred KB at most is best).");
    const reader = new FileReader();
    reader.onload = () => setD((p) => ({ ...p, mode: "upload", dataUrl: String(reader.result ?? "") }));
    reader.readAsDataURL(f);
  }

  function save() {
    setError(null);
    start(async () => {
      const image = d.mode === "upload" ? { kind: "upload" as const, dataUrl: d.dataUrl } : d.mode === "url" ? { kind: "url" as const, url: d.url } : { kind: "keep" as const };
      if (image.kind === "upload" && !image.dataUrl) return setError("Pick the banner's picture.");
      const r = await saveSignatureBanner({
        id: d.id,
        name: d.name,
        image,
        linkUrl: d.linkUrl,
        altText: d.altText,
        width,
        startsOn: d.startsOn || null,
        endsOn: d.endsOn || null,
        templateIds: d.everybody ? [] : d.templateIds,
        paused: d.paused,
      });
      if (!r.ok) return setError(r.error);
      router.refresh();
      onDone();
    });
  }

  const modes: { key: Draft["mode"]; label: string }[] = [...(d.id ? [{ key: "keep" as const, label: "Keep this picture" }] : []), { key: "upload", label: "Upload a picture" }, { key: "url", label: "Use an https:// address" }];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="sb-name">Name</Label>
          <Input id="sb-name" maxLength={60} value={d.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Trade fair, March" />
          <p className="text-xs text-subtle">For you — it isn&apos;t shown in emails.</p>
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">Picture</h3>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Where the picture comes from">
            {modes.map((m) => (
              <button
                key={m.key}
                type="button"
                role="radio"
                aria-checked={d.mode === m.key}
                onClick={() => set("mode", m.key)}
                className={cn("rounded-base border px-3 py-1.5 text-sm", d.mode === m.key ? "border-brand bg-brand-subtle text-text" : "border-line text-muted hover:border-line-strong")}
              >
                {m.label}
              </button>
            ))}
          </div>
          {d.mode === "upload" && (
            <div className="flex flex-wrap items-center gap-3">
              <input ref={file} type="file" accept={UPLOAD_TYPES.join(",")} className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
              <Button type="button" variant="secondary" onClick={() => file.current?.click()}>
                <ImagePlus className="h-4 w-4" />
                {d.dataUrl ? "Pick another" : "Pick a picture"}
              </Button>
              <p className="text-xs text-subtle">PNG, JPEG or GIF, 1 MB at most — served from your workspace&apos;s own https address. About 600 × 100 pixels works well.</p>
            </div>
          )}
          {d.mode === "url" && (
            <div className="space-y-1.5">
              <Input aria-label="The picture's address" maxLength={500} value={d.url} onChange={(e) => set("url", e.target.value)} placeholder="https://yourcompany.com/banners/fair.png" />
              {d.url && imageNote(d.url) && <p className="text-xs text-danger">{imageNote(d.url)}</p>}
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sb-link">Links to (https://)</Label>
            <Input id="sb-link" maxLength={500} value={d.linkUrl} onChange={(e) => set("linkUrl", e.target.value)} placeholder="yourcompany.com/fair" />
            {linkNote(d.linkUrl) && <p className="text-xs text-danger">{linkNote(d.linkUrl)}</p>}
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="sb-alt">What it says</Label>
            <Input id="sb-alt" maxLength={150} value={d.altText} onChange={(e) => set("altText", e.target.value)} placeholder="Meet us at the trade fair, hall 4, 12–14 March" />
            <p className="text-xs text-subtle">Shown where pictures are blocked, and read out by screen readers.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-width">Width (pixels)</Label>
            <Input id="sb-width" type="number" min={BANNER_WIDTH.min} max={BANNER_WIDTH.max} value={d.width} onChange={(e) => set("width", Number(e.target.value))} />
          </div>
          <div />
          <div className="space-y-1.5">
            <Label htmlFor="sb-start">Starts</Label>
            <Input id="sb-start" type="date" value={d.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sb-end">Ends</Label>
            <Input id="sb-end" type="date" value={d.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
          </div>
          <p className="text-xs text-subtle sm:col-span-2">Leave them empty to start now and run until you pause it. Days are your workspace&apos;s.</p>
        </div>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">Under whose signature</h3>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="radio" name="sb-audience" checked={d.everybody} onChange={() => set("everybody", true)} />
            Everybody&apos;s
          </label>
          <label className="flex items-center gap-2 text-sm text-text">
            <input type="radio" name="sb-audience" checked={!d.everybody} onChange={() => set("everybody", false)} />
            The signatures of these templates
          </label>
          {!d.everybody && (
            <div className="flex flex-wrap gap-x-5 gap-y-2 pl-6">
              {templates.map((t) => (
                <label key={t.id} className="flex items-center gap-2 text-sm text-text">
                  <input type="checkbox" checked={d.templateIds.includes(t.id)} onChange={(e) => set("templateIds", e.target.checked ? [...d.templateIds, t.id] : d.templateIds.filter((x) => x !== t.id))} />
                  {t.name}
                </label>
              ))}
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {error && <p className="mr-auto text-sm text-danger">{error}</p>}
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save banner"}
          </Button>
        </div>
      </div>
      <div className="space-y-2 lg:sticky lg:top-4 lg:self-start">
        <p className="text-xs font-medium uppercase tracking-wide text-subtle">Preview — under the company signature</p>
        <Card className="overflow-x-auto bg-white px-5 py-5 text-[#333333]">
          {/* Built by renderAnySignature on the server, which escapes everything and allows only safe links. */}
          <div dangerouslySetInnerHTML={{ __html: sampleHtml }} />
          {shownSrc && (
            <div style={{ marginTop: 14 }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- shown as mail programs will show it */}
              <img src={shownSrc} alt={d.altText} width={width} style={{ display: "block", border: 0, width, maxWidth: "100%", height: "auto" }} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
