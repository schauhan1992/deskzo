/**
 * What the browser is allowed to do on a given page, as a pure function of the path.
 *
 * Built here rather than inline in the proxy so it can be asserted. The blanket `camera=()` was
 * correct-looking, committed, and silently broke the one feature in the app that needs a camera:
 * the reception kiosk requires a photo to sign a visitor in, and the header made `getUserMedia`
 * fail before the page could ask. Every visitor then took the "camera unavailable" path, which
 * exists for a broken webcam and says nothing when it becomes the normal case.
 *
 * A header that disables a feature is exactly the kind of thing no test notices, so there is one.
 */

/** The one prefix that genuinely needs a camera. */
export function needsCamera(pathname: string): boolean {
  return pathname === "/kiosk" || pathname.startsWith("/kiosk/");
}

/**
 * The pages that ask where somebody is, each once, at a tap: the access page, for a role that records location at
 * sign-in; and, for GPS attendance (owner, 22 Oct 2026), the two pages with the Clock in button and the one where
 * HR may fill an office's point from where they stand. Nowhere else — and never tracked afterwards.
 */
const LOCATION_PAGES = new Set(["/access", "/people/me", "/people/attendance", "/settings/attendance-locations"]);

export function needsLocation(pathname: string): boolean {
  return LOCATION_PAGES.has(pathname);
}

/**
 * `self` rather than `*` on the kiosk, and closed everywhere else — so the rest of the app keeps
 * the property that a compromised dependency cannot ask for a camera at all.
 */
export function permissionsPolicyFor(pathname: string): string {
  return [
    needsCamera(pathname) ? "camera=(self)" : "camera=()",
    "microphone=()",
    needsLocation(pathname) ? "geolocation=(self)" : "geolocation=()",
    "interest-cohort=()",
  ].join(", ");
}
