export type Branding = {
  appName: string;
  shortName: string | null;
  tagline: string | null;
  logoDataUrl: string | null;
  faviconDataUrl: string | null;
  primaryColor: string;
  defaultTheme: string;
};

export const DEFAULT_BRANDING: Branding = {
  appName: "Deskzo One",
  shortName: null,
  tagline: null,
  logoDataUrl: null,
  faviconDataUrl: null,
  primaryColor: "#4f46e5",
  defaultTheme: "system",
};

/** Suggested brand colours — a starting point, any hex is allowed. */
export const BRAND_PRESETS = [
  { name: "Indigo", value: "#4f46e5" },
  { name: "Blue", value: "#2563eb" },
  { name: "Teal", value: "#0d9488" },
  { name: "Emerald", value: "#059669" },
  { name: "Violet", value: "#7c3aed" },
  { name: "Rose", value: "#e11d48" },
  { name: "Amber", value: "#d97706" },
  { name: "Slate", value: "#475569" },
] as const;

export const HEX_PATTERN = /^#([0-9a-fA-F]{6})$/;

/** Initials for the collapsed sidebar when no short name is set. */
export function brandInitials(branding: Branding) {
  if (branding.shortName) return branding.shortName.slice(0, 3);
  return branding.appName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

/**
 * White text on a mid-to-dark brand colour, near-black on a light one — so a pale brand colour
 * doesn't produce unreadable buttons. Uses the standard sRGB relative-luminance formula.
 */
export function contrastColor(hex: string) {
  const match = HEX_PATTERN.exec(hex);
  if (!match) return "#ffffff";
  const int = parseInt(match[1], 16);
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.55 ? "#16191d" : "#ffffff";
}

/** The `<style>` payload that makes the configured brand colour real for the whole app. */
export function brandingCss(branding: Branding) {
  const color = HEX_PATTERN.test(branding.primaryColor) ? branding.primaryColor : DEFAULT_BRANDING.primaryColor;
  return `:root{--brand:${color};--brand-contrast:${contrastColor(color)}}`;
}
