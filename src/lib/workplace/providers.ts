/**
 * Microsoft 365, Google Workspace and Zoho — the three suites a company can bring (owner, 2 Oct 2026),
 * each for signing in and for the mailboxes people connect. The facts about them that every side
 * needs, safe in the browser: names, the addresses a company registers, Zoho's data centres.
 *
 * What a workspace has set up is in src/lib/workplace/settings.ts; signing in with them in
 * src/lib/auth.ts and src/lib/workplace/sign-in.ts; mailboxes in src/lib/mail.
 */

export const WORKPLACE_PROVIDERS = ["MICROSOFT", "GOOGLE", "ZOHO"] as const;
export type WorkplaceProvider = (typeof WORKPLACE_PROVIDERS)[number];

/** The suite, as the company knows it. */
export const PROVIDER_NAMES: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Microsoft 365",
  GOOGLE: "Google Workspace",
  ZOHO: "Zoho",
};

/** The short name on a sign-in button: "Sign in with Microsoft". */
export const SIGN_IN_NAMES: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Microsoft",
  GOOGLE: "Google",
  ZOHO: "Zoho",
};

/** The mailbox, as people know it. */
export const MAIL_NAMES: Record<WorkplaceProvider, string> = {
  MICROSOFT: "Outlook",
  GOOGLE: "Gmail",
  ZOHO: "Zoho Mail",
};

/** Auth.js's id for each — the segment of /api/auth/callback/<id>, and SignIn.provider. */
export const SIGN_IN_IDS: Record<WorkplaceProvider, string> = {
  MICROSOFT: "microsoft-entra-id",
  GOOGLE: "google",
  ZOHO: "zoho",
};

/** The suite a sign-in came through, from Auth.js's id; null for a password, a handoff or a linked switch. */
export function providerOfSignIn(id: string | null | undefined): WorkplaceProvider | null {
  for (const provider of WORKPLACE_PROVIDERS) if (SIGN_IN_IDS[provider] === id) return provider;
  return null;
}

/** Whether a sign-in came through one of the suites — "single sign-on", whichever. */
export function isSsoSignIn(id: string | null | undefined): boolean {
  return providerOfSignIn(id) !== null;
}

/** A list of names said as a person would: "Microsoft", "Microsoft or Google", "Microsoft, Google or Zoho". */
export function sayEither(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** The URL segment of a mailbox's own connect and callback routes (src/app/api/mail/[provider]). */
export const MAIL_SLUGS: Record<WorkplaceProvider, string> = {
  MICROSOFT: "microsoft",
  GOOGLE: "google",
  ZOHO: "zoho",
};

export function providerOfMailSlug(slug: string | null | undefined): WorkplaceProvider | null {
  for (const provider of WORKPLACE_PROVIDERS) if (MAIL_SLUGS[provider] === slug) return provider;
  return null;
}

/** Where a mailbox connection starts; `next` is where it lands afterwards. */
export function mailConnectPath(provider: WorkplaceProvider, next?: string): string {
  const path = `/api/mail/${MAIL_SLUGS[provider]}/connect`;
  return next ? `${path}?next=${encodeURIComponent(next)}` : path;
}

/** The address a mailbox connection comes back to — registered with the provider. */
export function mailCallbackPath(provider: WorkplaceProvider): string {
  return `/api/mail/${MAIL_SLUGS[provider]}/callback`;
}

/** The address a sign-in comes back to — registered with the provider. */
export function signInCallbackPath(provider: WorkplaceProvider): string {
  return `/api/auth/callback/${SIGN_IN_IDS[provider]}`;
}

/**
 * Zoho's data centres. A company's accounts live in one, and every call for them goes to its servers:
 * the accounts server for sign-in and tokens, Zoho Mail's for sending. A token request carries the
 * company's client secret, so it only ever goes to an accounts server named here — never to one a
 * redirect merely mentions (src/lib/mail/zoho.ts).
 */
export const ZOHO_REGIONS = {
  in: { label: "India — zoho.in", accounts: "https://accounts.zoho.in", mail: "https://mail.zoho.in", console: "https://api-console.zoho.in" },
  com: { label: "United States — zoho.com", accounts: "https://accounts.zoho.com", mail: "https://mail.zoho.com", console: "https://api-console.zoho.com" },
  eu: { label: "Europe — zoho.eu", accounts: "https://accounts.zoho.eu", mail: "https://mail.zoho.eu", console: "https://api-console.zoho.eu" },
  uk: { label: "United Kingdom — zoho.uk", accounts: "https://accounts.zoho.uk", mail: "https://mail.zoho.uk", console: "https://api-console.zoho.uk" },
  "com.au": { label: "Australia — zoho.com.au", accounts: "https://accounts.zoho.com.au", mail: "https://mail.zoho.com.au", console: "https://api-console.zoho.com.au" },
  jp: { label: "Japan — zoho.jp", accounts: "https://accounts.zoho.jp", mail: "https://mail.zoho.jp", console: "https://api-console.zoho.jp" },
  ca: { label: "Canada — zohocloud.ca", accounts: "https://accounts.zohocloud.ca", mail: "https://mail.zohocloud.ca", console: "https://api-console.zohocloud.ca" },
  sa: { label: "Saudi Arabia — zoho.sa", accounts: "https://accounts.zoho.sa", mail: "https://mail.zoho.sa", console: "https://api-console.zoho.sa" },
} as const;
export type ZohoRegion = keyof typeof ZOHO_REGIONS;
export const ZOHO_REGION_KEYS = Object.keys(ZOHO_REGIONS) as ZohoRegion[];

export function readZohoRegion(value: unknown): ZohoRegion {
  return typeof value === "string" && value in ZOHO_REGIONS ? (value as ZohoRegion) : "in";
}

/**
 * A Google Workspace domain as typed — "wroffy.com", not an address or a URL. Null when it isn't one.
 */
export function readGoogleDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/^@/, "");
  return /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}
