import type { DeviceKind } from "@prisma/client";

/**
 * What kind of device a request came from, and what to call it — from the browser's own
 * description of itself.
 *
 * Stated plainly because the settings screen has to: the user agent is written by the browser, so
 * "phone" and "computer" are what the browser says it is. That holds for everybody using a browser
 * normally, and a determined person can make a phone claim to be a laptop. Device *approval* is the
 * control that does not depend on the browser's word — it depends on a token only the approved
 * browser holds.
 *
 * Pure, so it can be tested against real agent strings and used on either side.
 */

export const DEVICE_KIND_LABEL: Record<DeviceKind, string> = {
  MOBILE: "Phone",
  TABLET: "Tablet",
  COMPUTER: "Laptop or desktop",
};

/**
 * `sec-ch-ua-mobile` is the Chromium client hint — `?1` on a phone. Consulted as well as the agent
 * because Chrome is freezing the agent string, and the hint is the part that stays accurate.
 */
export function deviceKindFrom(userAgent: string | null | undefined, mobileHint?: string | null): DeviceKind {
  const ua = userAgent ?? "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle|SM-T\d|Nexus (7|9|10)/i.test(ua)) return "TABLET";
  // Android without "Mobile" is a tablet: that is how Android browsers tell the two apart.
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return "TABLET";
  if (mobileHint === "?1") return "MOBILE";
  if (/iPhone|iPod|Android.*Mobile|Windows Phone|Mobile Safari|Opera Mini|IEMobile|BlackBerry/i.test(ua)) return "MOBILE";
  // An iPad on iPadOS 13 or later asks for desktop sites and says it is a Mac. Without JavaScript
  // there is no telling it apart, so it is a computer here — which is why approval, not type, is
  // the control to rely on.
  return "COMPUTER";
}

const BROWSERS: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser/, "Samsung Internet"],
  [/Firefox\/|FxiOS/, "Firefox"],
  [/CriOS|Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows/, "Windows"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "Mac"],
  [/Linux/, "Linux"],
];

/** "Chrome on Windows", "Safari on iPhone". What a person recognises their own device by. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "A browser";
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  return system ? `${browser} on ${system}` : browser;
}
