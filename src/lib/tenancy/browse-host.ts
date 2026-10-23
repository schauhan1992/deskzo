import { protocolFor } from "@/lib/tenancy/host";

/**
 * One address to use (owner, 23 Oct 2026). A workspace with a custom domain made primary — crm.acme.com, say — is
 * reached at it by every person's browser: opening a page on its own subdomain (acme.deskzo.com) sends the browser
 * to the same page there. Sign-in is per address (src/lib/auth-session.ts: the session cookie is bound to the exact
 * host), so without this people signed in twice and bookmarked both.
 *
 * Only a person's browser opening a page is sent on. Everything else keeps the subdomain, exactly as before:
 *
 *   · anything but GET and HEAD — a form's POST is never redirected;
 *   · /api — the Deskzo app, the public API, webhooks, sign-in callbacks (and /iclock, outside the proxy);
 *   · what isn't a page being opened — a script's fetch, a prefetch, a link checker without a browser's headers;
 *   · Android web views — the Deskzo app's own page view (mobile/src/app/web.tsx) signs in on the subdomain and
 *     opens anything outside it in the phone's browser, so a redirect would throw it out of the app;
 *   · the server's own headless browser printing a document's PDF (src/lib/tenancy/render-target.ts);
 *   · a service worker's script and /.well-known files, which belong to the address they're on.
 *
 * And only while the primary address is live and its checks pass (src/lib/platform/domains.ts): one that starts
 * failing stops the redirect at once, so a domain gone wrong never strands anybody — the subdomain always works.
 * A temporary redirect (307), never cached by browsers, so unsetting the primary takes effect at once.
 */

export type BrowseRequest = {
  /** The request's host, as the proxy normalised it. */
  host: string;
  /** Whether it came in on the workspace's own subdomain — the only address sent on. */
  onSubdomain: boolean;
  /** Where browsers go: the workspace's live, passing primary address (Tenant.browseHost). */
  browseHost: string | null | undefined;
  method: string;
  pathname: string;
  /** "?…", or empty. */
  search: string;
  headers: Headers;
};

const KEEP_PATH = /^\/(api|_next)(\/|$)|^\/\.well-known\/|^\/(sw\.js|robots\.txt|favicon\.ico)$/;

/** Whether a request is a person's browser opening a page: a navigation, or — from an older browser — one asking for HTML. */
function opensPage(headers: Headers): boolean {
  const mode = headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  return /text\/html/.test(headers.get("accept") ?? "");
}

/** Browsers the redirect must not touch: an Android web view (the Deskzo app's page view), and the PDF printer. */
function keepsItsAddress(headers: Headers): boolean {
  const agent = headers.get("user-agent") ?? "";
  return /; wv\)/.test(agent) || /HeadlessChrome/.test(agent);
}

/** Where to send this request instead, or null to serve it where it is. */
export function browseRedirect(r: BrowseRequest): string | null {
  if (!r.onSubdomain || !r.browseHost || r.browseHost === r.host) return null;
  if (r.method !== "GET" && r.method !== "HEAD") return null;
  if (KEEP_PATH.test(r.pathname)) return null;
  if (!opensPage(r.headers) || keepsItsAddress(r.headers)) return null;
  return `${protocolFor(r.browseHost)}://${r.browseHost}${r.pathname}${r.search}`;
}

/**
 * The address browsers are sent to, from a workspace's live addresses: its primary one, while its checks pass —
 * null when there's no primary, or it has started failing (the subdomain serves meanwhile).
 */
export function browseHostOf(domains: { host: string; isPrimary: boolean; failingSince: Date | null }[]): string | null {
  const primary = domains.find((d) => d.isPrimary);
  return primary && !primary.failingSince ? primary.host : null;
}
