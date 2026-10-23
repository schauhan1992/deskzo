import type { Metadata, MetadataRoute } from "next";
import { getBranding } from "@/actions/branding";
import { DEFAULT_BRANDING, HEX_PATTERN, type Branding } from "@/lib/branding";
import { deskzoIconDataUrl } from "@/lib/brand/deskzo-logo";

/**
 * The workspace as an app on a phone's home screen (owner, 21 Oct 2026) — an iPhone's above all, which has
 * no Deskzo app to install: Add to Home Screen opens the workspace full screen, under its own name and icon,
 * signed in like the browser. It is the web itself, so it is never out of date; what only the Android app can
 * do (reading the call log, blocking screenshots) no iPhone app may do at all.
 *
 * Each workspace's address installs as its own app — on a phone, and on a Windows or Mac computer from Chrome or
 * Edge — under the workspace's name and colour (Settings › Branding), with Deskzo's icon (owner, 23 Oct 2026:
 * Deskzo's icon on the apps and the browser tab, the company's own logo inside them). Served under /api/pwa,
 * which needs no session. The service worker is public/sw.js.
 */

/**
 * The browser tab's icon, on every workspace and on Deskzo's own pages: Deskzo's, sharp at any size, with the
 * .ico for browsers that don't take an SVG. A company's own logo shows inside the app, not here.
 */
export function deskzoFavicons(): { icon: { url: string; sizes?: string; type?: string }[] } {
  return {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: deskzoIconDataUrl(), type: "image/svg+xml" },
    ],
  };
}

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


/**
 * What a workspace page adds to its head so it installs as the workspace's app — on the signed-in pages
 * and the sign-in page, never the public ones (a customer's form or portal is not this app). Deskzo's favicon
 * is repeated because a layout's `icons` replaces the root layout's.
 */
export async function appMetadata(): Promise<Metadata> {
  const branding = await getBranding();
  return {
    manifest: PWA_MANIFEST_PATH,
    appleWebApp: { capable: true, title: homeScreenName(branding), statusBarStyle: "default" },
    icons: {
      ...deskzoFavicons(),
      apple: [{ url: iconPath("180"), sizes: "180x180", type: "image/png" }],
    },
    // The name older iPhones read before they honoured the manifest's "standalone".
    other: { "apple-mobile-web-app-capable": "yes" },
  };
}
