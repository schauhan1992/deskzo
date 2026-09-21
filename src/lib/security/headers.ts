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
 * `self` rather than `*` on the kiosk, and closed everywhere else — so the rest of the app keeps
 * the property that a compromised dependency cannot ask for a camera at all.
 */
export function permissionsPolicyFor(pathname: string): string {
  return [
    needsCamera(pathname) ? "camera=(self)" : "camera=()",
    "microphone=()",
    "geolocation=()",
    "interest-cohort=()",
  ].join(", ");
}
