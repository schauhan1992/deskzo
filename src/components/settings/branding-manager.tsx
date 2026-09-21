"use client";

import { useRef, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Upload, Trash2, Check } from "lucide-react";
import { updateBranding, uploadBrandingImage, removeBrandingImage } from "@/actions/branding";
import { BRAND_PRESETS, HEX_PATTERN, brandInitials, contrastColor, type Branding } from "@/lib/branding";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export function BrandingManager({ branding }: { branding: Branding }) {
  const router = useRouter();
  const [appName, setAppName] = useState(branding.appName);
  const [shortName, setShortName] = useState(branding.shortName ?? "");
  const [tagline, setTagline] = useState(branding.tagline ?? "");
  const [primaryColor, setPrimaryColor] = useState(branding.primaryColor);
  const [defaultTheme, setDefaultTheme] = useState(branding.defaultTheme);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();
  const logoInput = useRef<HTMLInputElement>(null);
  const faviconInput = useRef<HTMLInputElement>(null);

  const validColor = HEX_PATTERN.test(primaryColor);
  const preview: Branding = { ...branding, appName, shortName: shortName || null, primaryColor };

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateBranding({ appName, shortName, tagline, primaryColor, defaultTheme });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  function upload(kind: "logo" | "favicon", file: File) {
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      startTransition(async () => {
        const result = await uploadBrandingImage(kind, dataUrl);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        router.refresh();
      });
    };
    reader.readAsDataURL(file);
  }

  function remove(kind: "logo" | "favicon") {
    startTransition(async () => {
      await removeBrandingImage(kind);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/* Live preview — the colour is applied to this block only, so you see the result before saving. */}
      <div
        className="rounded-xl border border-line bg-surface-sunken p-4"
        style={validColor ? ({ ["--brand" as string]: primaryColor, ["--brand-contrast" as string]: contrastColor(primaryColor) } as React.CSSProperties) : undefined}
      >
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-subtle">Preview</div>
        <div className="flex flex-wrap items-center gap-3">
          {branding.logoDataUrl ? (
            <Image src={branding.logoDataUrl} alt="" width={112} height={28} unoptimized className="h-7 w-auto max-w-[130px] object-contain" />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-xs font-bold text-brand-contrast">
              {brandInitials(preview)}
            </span>
          )}
          <span className="text-sm font-semibold text-text">{appName || "Your app"}</span>
          <Button size="sm">Primary action</Button>
          <Button size="sm" variant="secondary">
            Secondary
          </Button>
          <Badge tone="brand">Brand</Badge>
          <Badge tone="green">Active</Badge>
          <Badge tone="amber">Onboarding</Badge>
          <Badge tone="red">Overdue</Badge>
        </div>
        {tagline && <p className="mt-2 text-xs text-muted">{tagline}</p>}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="appName">App name</Label>
          <Input id="appName" value={appName} onChange={(e) => setAppName(e.target.value)} />
          <p className="text-xs text-subtle">Shown in the sidebar, the browser tab and on the sign-in screen.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="shortName">Short name</Label>
          <Input
            id="shortName"
            value={shortName}
            onChange={(e) => setShortName(e.target.value)}
            maxLength={4}
            placeholder={brandInitials({ ...branding, appName, shortName: null })}
          />
          <p className="text-xs text-subtle">Up to 4 characters, used when the sidebar is collapsed.</p>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="tagline">Tagline</Label>
          <Input id="tagline" value={tagline} onChange={(e) => setTagline(e.target.value)} placeholder="Optional — shown on the sign-in screen" />
        </div>
      </div>

      <div className="space-y-2">
        <Label>Brand colour</Label>
        <div className="flex flex-wrap items-center gap-2">
          {BRAND_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              title={preset.name}
              aria-label={preset.name}
              onClick={() => setPrimaryColor(preset.value)}
              className={cn(
                "grid h-8 w-8 place-items-center rounded-full border-2 transition-transform hover:scale-110",
                primaryColor.toLowerCase() === preset.value.toLowerCase() ? "border-text" : "border-transparent",
              )}
              style={{ backgroundColor: preset.value }}
            >
              {primaryColor.toLowerCase() === preset.value.toLowerCase() && (
                <Check className="h-4 w-4" style={{ color: contrastColor(preset.value) }} />
              )}
            </button>
          ))}
          <input
            type="color"
            value={validColor ? primaryColor : "#4f46e5"}
            onChange={(e) => setPrimaryColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-line-strong bg-surface"
            aria-label="Custom colour"
          />
          <Input
            value={primaryColor}
            onChange={(e) => setPrimaryColor(e.target.value)}
            className="h-8 w-28 font-mono text-xs"
            aria-label="Brand colour hex"
          />
        </div>
        {!validColor && <p className="text-xs text-danger">Use a 6-digit hex colour, e.g. #4f46e5.</p>}
        <p className="text-xs text-subtle">Every accent, active menu item and focus ring is derived from this one colour.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>Logo</Label>
          <div className="flex items-center gap-3 rounded-base border border-line bg-surface-sunken p-3">
            {branding.logoDataUrl ? (
              <Image src={branding.logoDataUrl} alt="Logo" width={112} height={32} unoptimized className="h-8 w-auto max-w-[120px] object-contain" />
            ) : (
              <span className="text-xs text-subtle">No logo — initials are used instead.</span>
            )}
            <div className="ml-auto flex gap-1">
              <Button type="button" variant="secondary" size="sm" disabled={isPending} onClick={() => logoInput.current?.click()}>
                <Upload className="h-3.5 w-3.5" />
                Upload
              </Button>
              {branding.logoDataUrl && (
                <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => remove("logo")}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
          <input
            ref={logoInput}
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload("logo", file);
              e.target.value = "";
            }}
          />
          <p className="text-xs text-subtle">PNG, JPEG, SVG or WebP up to 256KB. A wide logo works best.</p>
        </div>

        <div className="space-y-2">
          <Label>Favicon</Label>
          <div className="flex items-center gap-3 rounded-base border border-line bg-surface-sunken p-3">
            {branding.faviconDataUrl ? (
              <Image src={branding.faviconDataUrl} alt="Favicon" width={24} height={24} unoptimized className="h-6 w-6 object-contain" />
            ) : (
              <span className="text-xs text-subtle">Using the default icon.</span>
            )}
            <div className="ml-auto flex gap-1">
              <Button type="button" variant="secondary" size="sm" disabled={isPending} onClick={() => faviconInput.current?.click()}>
                <Upload className="h-3.5 w-3.5" />
                Upload
              </Button>
              {branding.faviconDataUrl && (
                <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={() => remove("favicon")}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>
          <input
            ref={faviconInput}
            type="file"
            accept="image/png,image/x-icon,image/svg+xml"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload("favicon", file);
              e.target.value = "";
            }}
          />
          <p className="text-xs text-subtle">A square PNG or ICO, 32×32 or larger.</p>
        </div>
      </div>

      <div className="space-y-1.5 sm:max-w-xs">
        <Label htmlFor="defaultTheme">Default theme</Label>
        <Select id="defaultTheme" value={defaultTheme} onChange={(e) => setDefaultTheme(e.target.value)}>
          <option value="system">Follow the device</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </Select>
        <p className="text-xs text-subtle">The starting point for anyone who hasn&apos;t picked their own theme yet.</p>
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="flex items-center gap-3">
        <Button type="button" disabled={isPending || !validColor} onClick={save}>
          {isPending ? "Saving…" : "Save branding"}
        </Button>
        {saved && <span className="text-sm text-success">Saved — the whole app now uses it.</span>}
      </div>
    </div>
  );
}
