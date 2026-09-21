import { NextResponse } from "next/server";

/**
 * The kiosk's service worker.
 *
 * A PWA is only installable with one, which is the only reason this exists — so it is deliberately
 * the smallest thing that satisfies that: it claims clients and gets out of the way.
 *
 * It caches **nothing**. A reception tablet is on the office wifi and always online, and a cached
 * response here would be a cached copy of the staff directory sitting in a browser in a lobby.
 * Served from /kiosk/sw so its scope is /kiosk/ and it can never touch the signed-in app.
 */
const SOURCE = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
// No fetch handler on purpose: nothing about a visitor form should survive a refresh.
`;

export function GET() {
  return new NextResponse(SOURCE, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "service-worker-allowed": "/kiosk/",
      "cache-control": "no-store",
    },
  });
}
