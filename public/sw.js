/*
 * The service worker of the workspace app on a phone's home screen (src/lib/pwa.ts).
 *
 * It does one thing: when a page can't be reached because the phone is offline, it shows a plain
 * "You're offline" screen instead of the browser's error. Nothing a workspace shows is ever kept here —
 * no page, no figure, no file — so an installed app can never show yesterday's numbers, or one person's
 * pages to the next one signed in. The only thing kept is the workspace's manifest (its name and colour,
 * public on its sign-in page), for that screen. Every request still goes to the server, as it would
 * without this worker; a server that answers with an error is shown as it answers.
 *
 * Public in the proxy (src/proxy.ts), so it installs and updates for anybody signed in or not.
 */
const VERSION = "deskzo-app-1";
const MANIFEST = "/api/pwa/manifest";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(new Request(MANIFEST, { cache: "reload" })))
      .catch(() => undefined),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name)));
      // The page's request starts while the worker wakes up, rather than after.
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable().catch(() => undefined);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Opening a page only. Everything else — data, files, actions, live updates — is left to the browser.
  if (request.mode !== "navigate" || request.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        return offlinePage();
      }
    })(),
  );
});

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function offlinePage() {
  let name = "Deskzo";
  let color = "#4f46e5";
  try {
    const cached = await caches.match(MANIFEST);
    if (cached) {
      const manifest = await cached.json();
      if (typeof manifest.name === "string" && manifest.name) name = manifest.name;
      if (typeof manifest.theme_color === "string" && /^#[0-9a-fA-F]{6}$/.test(manifest.theme_color)) color = manifest.theme_color;
    }
  } catch {
    // The defaults above.
  }
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(name)} — offline</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; }
  @media (prefers-color-scheme: dark) { body { background: #0b1120; color: #e2e8f0; } p { color: #94a3b8; } }
  main { max-width: 22rem; text-align: center; }
  h1 { font-size: 1.25rem; margin: 0 0 8px; }
  p { margin: 0 0 20px; color: #475569; line-height: 1.5; }
  a { display: inline-block; padding: 10px 18px; border-radius: 8px; background: ${color}; color: #fff; text-decoration: none; font-weight: 600; }
</style>
</head>
<body>
<main>
  <h1>You're offline</h1>
  <p>${escapeHtml(name)} needs the internet. It opens again as soon as your phone is back online.</p>
  <a href="">Try again</a>
</main>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
