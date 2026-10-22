/**
 * The browser's side of reading a location on the pages allowed to (src/lib/security/headers.ts). A page's
 * Permissions-Policy belongs to the document it was loaded as: reached by a link inside the app, the document is
 * still whichever page was opened first — where location is closed — so the browser refuses before it even asks.
 * These helpers say whether this document may ask, and reload the page as itself, carrying the tap across, when not.
 */

type PolicyDoc = Document & { permissionsPolicy?: { allowsFeature(f: string): boolean }; featurePolicy?: { allowsFeature(f: string): boolean } };

/** Whether this document may use geolocation: true or false where the browser says, null where it can't tell. */
export function locationAllowedHere(): boolean | null {
  if (typeof document === "undefined") return null;
  const doc = document as PolicyDoc;
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy ? policy.allowsFeature("geolocation") : null;
}

/** Reloads this page as itself, noting what was tapped so the reloaded page can carry on with it. Once only. */
export function reloadToUseLocation(param: string, value: string): boolean {
  const url = new URL(window.location.href);
  if (url.searchParams.has(param)) return false;
  url.searchParams.set(param, value);
  window.location.assign(url.toString());
  return true;
}

/** What the reload carried, read once and taken off the address — only when it is `expected`, if one is given. */
export function takeCarriedTap(param: string, expected?: string): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const value = url.searchParams.get(param);
  if (value === null || (expected !== undefined && value !== expected)) return null;
  url.searchParams.delete(param);
  window.history.replaceState(window.history.state, "", url.toString());
  return value;
}
