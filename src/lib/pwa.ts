import type { Metadata, MetadataRoute } from "next";
import { getBranding } from "@/actions/branding";
import { DEFAULT_BRANDING, HEX_PATTERN, type Branding } from "@/lib/branding";

/**
 * The workspace as an app on a phone's home screen (owner, 21 Oct 2026) — an iPhone's above all, which has
 * no Deskzo app to install: Add to Home Screen opens the workspace full screen, under its own name and icon,
 * signed in like the browser. It is the web itself, so it is never out of date; what only the Android app can
 * do (reading the call log, blocking screenshots) no iPhone app may do at all.
 *
 * Each workspace's address installs as its own app — the manifest, the icons and the name are the
 * workspace's branding (Settings › Branding). Served under /api/pwa, which needs no session: the same name,
 * colour and logo its sign-in page shows anybody. The service worker is public/sw.js.
 */

export const PWA_MANIFEST_PATH = "/api/pwa/manifest";

/** The icons drawn for it: 180 for an iPhone's home screen, 192 and 512 for Android, and the maskable one Android crops to its own shape. */
export const PWA_ICONS = {
  "180": { size: 180, maskable: false, rounded: false },
  "192": { size: 192, maskable: false, rounded: true },
  "512": { size: 512, maskable: false, rounded: true },
  maskable: { size: 512, maskable: true, rounded: false },
} as const;
export type PwaIcon = keyof typeof PWA_ICONS;

export const isPwaIcon = (name: string): name is PwaIcon => Object.hasOwn(PWA_ICONS, name);

const iconPath = (name: PwaIcon) => `/api/pwa/icon/${name}`;

/** The name under the icon — a home screen shows about twelve letters, so the short name when there is one. */
export function homeScreenName(branding: Branding): string {
  return (branding.shortName?.trim() || branding.appName.trim() || DEFAULT_BRANDING.appName).slice(0, 30);
}

export function brandColor(branding: Branding): string {
  return HEX_PATTERN.test(branding.primaryColor) ? branding.primaryColor : DEFAULT_BRANDING.primaryColor;
}

export function pwaManifest(branding: Branding): MetadataRoute.Manifest {
  return {
    id: "/",
    name: branding.appName,
    short_name: homeScreenName(branding),
    description: branding.tagline ?? `${branding.appName}, on your phone.`,
    // Signed out, the proxy sends it to sign-in and back.
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: brandColor(branding),
    icons: [
      { src: iconPath("192"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: iconPath("512"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: iconPath("maskable"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}

/** A PNG's width and height, read from its header; null for anything else. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  if (String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Below this a picture blurs on a home screen; the workspace's initials are drawn instead. */
const MIN_ICON_PIXELS = 96;

/**
 * The picture on the icon: the favicon, else the logo — only one that stays sharp and square on a home
 * screen. An SVG favicon always does; a PNG must be 96 pixels or more, and a logo nearly square (most logos
 * are a wide wordmark, unreadable shrunk into a square). Anything else — a JPEG, WebP or .ico, whose size
 * isn't read here — leaves the initials on the brand colour, which always read.
 */
export function iconPicture(branding: Branding): string | null {
  const candidates: { dataUrl: string | null; svg: boolean }[] = [
    { dataUrl: branding.faviconDataUrl, svg: true },
    { dataUrl: branding.logoDataUrl, svg: false },
  ];
  for (const { dataUrl, svg } of candidates) {
    const match = dataUrl ? /^data:(image\/png|image\/svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
    if (!match) continue;
    if (match[1] === "image/svg+xml") {
      if (svg) return dataUrl;
      continue;
    }
    const size = pngSize(Buffer.from(match[2], "base64"));
    if (!size || Math.min(size.width, size.height) < MIN_ICON_PIXELS) continue;
    const ratio = size.width / size.height;
    if (ratio >= 0.8 && ratio <= 1.25) return dataUrl;
  }
  return null;
}

/**
 * What a workspace page adds to its head so it installs as the workspace's app — on the signed-in pages
 * and the sign-in page, never the public ones (a customer's form or portal is not this app). The favicon
 * is repeated because a layout's `icons` replaces the root layout's.
 */
export async function appMetadata(): Promise<Metadata> {
  const branding = await getBranding();
  return {
    manifest: PWA_MANIFEST_PATH,
    appleWebApp: { capable: true, title: homeScreenName(branding), statusBarStyle: "default" },
    icons: {
      ...(branding.faviconDataUrl ? { icon: branding.faviconDataUrl } : {}),
      apple: [{ url: iconPath("180"), sizes: "180x180", type: "image/png" }],
    },
    // The name older iPhones read before they honoured the manifest's "standalone".
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}
