/**
 * The workspace as an app on a phone's home screen (src/lib/pwa.ts): its manifest, its icons, the head tags
 * that make an iPhone install it, and the service worker (public/sw.js) — run in a stand-in browser to show
 * it keeps nothing of the workspace and only steps in when the phone is offline.
 *
 * The branding is a stand-in, swapped per case, so nothing in the database is read or written.
 *
 *   npm run check:pwa
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageResponse } from "next/og";
import type { Branding } from "../src/lib/branding";

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ── The workspace's branding, as the routes read it ─────────────────────────────────────────────

const BASE: Branding = {
  appName: "Acme Industries",
  shortName: null,
  tagline: null,
  logoDataUrl: null,
  faviconDataUrl: null,
  primaryColor: "#0f766e",
  defaultTheme: "system",
};
let branding: Branding = BASE;
const brandingStub = { getBranding: async () => branding };

const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown; _resolveFilename(request: string, parent: unknown, isMain: boolean): string };
const brandingFile = load.resolve("../src/actions/branding");
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/actions/branding") return brandingStub;
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved === brandingFile) return brandingStub;
  return realLoad.call(this, request, parent, isMain);
};

const pwa = load("../src/lib/pwa") as typeof import("../src/lib/pwa");
const manifestRoute = load("../src/app/api/pwa/manifest/route") as typeof import("../src/app/api/pwa/manifest/route");
const iconRoute = load("../src/app/api/pwa/icon/[name]/route") as typeof import("../src/app/api/pwa/icon/[name]/route");
const { InstallApp } = load("../src/components/layout/install-app") as typeof import("../src/components/layout/install-app");

/** A PNG of a plain square, drawn the way the icons are — a picture to put on one. */
async function pngOf(width: number, height: number): Promise<string> {
  const bytes = Buffer.from(await new ImageResponse(createElement("div", { style: { width: "100%", height: "100%", background: "#e11d48" } }), { width, height }).arrayBuffer());
  return `data:image/png;base64,${bytes.toString("base64")}`;
}
const svgOf = (body: string) => `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`;
const SQUARE_SVG = svgOf('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#1d4ed8"/></svg>');

async function icon(name: string) {
  const response = await iconRoute.GET(new Request(`https://acme.deskzo.com/api/pwa/icon/${name}`), { params: Promise.resolve({ name }) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { response, bytes, size: pwa.pngSize(bytes) };
}

async function main() {
  section("The manifest");
  {
    branding = { ...BASE, shortName: "Acme" };
    const response = await manifestRoute.GET();
    const manifest = (await response.json()) as Record<string, unknown> & { icons: { src: string; sizes: string; purpose: string }[] };
    ok("answered as a web app manifest", response.status === 200 && (response.headers.get("content-type") ?? "").startsWith("application/manifest+json"));
    ok("kept privately, never by a shared cache", response.headers.get("cache-control") === "private, max-age=3600");
    ok("the workspace's name, and its short name under the icon", manifest.name === "Acme Industries" && manifest.short_name === "Acme");
    ok("opens the dashboard, full screen, over the whole address", manifest.start_url === "/dashboard" && manifest.scope === "/" && manifest.display === "standalone" && manifest.id === "/");
    ok("in the brand colour", manifest.theme_color === "#0f766e");
    ok(
      "icons at 192 and 512, and a maskable one",
      manifest.icons.length === 3 &&
        manifest.icons.some((i) => i.sizes === "192x192" && i.purpose === "any") &&
        manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "any") &&
        manifest.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"),
    );
    ok("every icon it names is one the icon route draws", manifest.icons.every((i) => i.src.startsWith("/api/pwa/icon/") && pwa.isPwaIcon(i.src.slice("/api/pwa/icon/".length))));
    branding = { ...BASE, primaryColor: "red" };
    ok("a colour that isn't a hex colour falls back to the default", pwa.pwaManifest(branding).theme_color === "#4f46e5");
    ok("no short name: the app's name under the icon", pwa.homeScreenName({ ...BASE }) === "Acme Industries");
    ok("a very long name is cut for the home screen", pwa.homeScreenName({ ...BASE, appName: "A".repeat(80) }).length === 30);
  }

  section("The icons");
  {
    branding = BASE;
    for (const [name, spec] of Object.entries(pwa.PWA_ICONS)) {
      const { response, size } = await icon(name);
      ok(`${name}: a ${spec.size}×${spec.size} PNG`, response.status === 200 && response.headers.get("content-type") === "image/png" && size?.width === spec.size && size?.height === spec.size, size ? `${size.width}×${size.height}` : "not a PNG");
    }
    const unknown = await icon("1024");
    ok("an icon it doesn't draw is not found", unknown.response.status === 404);

    // Deskzo's icon on every workspace's app (owner, 23 Oct 2026): the company's favicon and logo don't change it.
    const deskzo192 = (await icon("192")).bytes;
    branding = { ...BASE, primaryColor: "#e11d48", faviconDataUrl: SQUARE_SVG, logoDataUrl: await pngOf(200, 200) };
    ok("a company's own favicon, logo and colour leave Deskzo's icon as it is", (await icon("192")).bytes.equals(deskzo192));
    ok("…on the iPhone's and the maskable one too", (await icon("180")).size?.width === 180 && (await icon("maskable")).size?.width === 512);
    const route = readFileSync(path.join(__dirname, "../src/app/api/pwa/icon/[name]/route.tsx"), "utf8");
    ok("drawn from Deskzo's icon, never the branding", /deskzoIconDataUrl/.test(route) && !/getBranding/.test(route));
    branding = BASE;

    ok("a PNG's size is read from its header", JSON.stringify(pwa.pngSize(Buffer.from((await pngOf(120, 64)).split(",")[1], "base64"))) === JSON.stringify({ width: 120, height: 64 }));
    ok("…and anything else has none", pwa.pngSize(Buffer.from("GIF89a-not-a-png-at-all")) === null);
  }

  section("What the pages add to their head");
  {
    branding = { ...BASE, shortName: "Acme", faviconDataUrl: SQUARE_SVG };
    const meta = await pwa.appMetadata();
    const apple = (meta.icons as { apple: { url: string; sizes: string }[] }).apple;
    const tab = (meta.icons as { icon: { url: string; type?: string }[] }).icon;
    ok("links the manifest", meta.manifest === "/api/pwa/manifest");
    ok("an iPhone opens it full screen, named as on the home screen", (meta.appleWebApp as { capable: boolean; title: string }).capable === true && (meta.appleWebApp as { title: string }).title === "Acme");
    ok("the iPhone's own icon at 180", apple.length === 1 && apple[0].url === "/api/pwa/icon/180" && apple[0].sizes === "180x180");
    ok(
      "Deskzo's icon in the tab, as an .ico and an SVG (a layout's icons replace the root's)",
      tab.length === 2 && tab[0].url === "/favicon.ico" && tab[1].type === "image/svg+xml" && tab[1].url.startsWith("data:image/svg+xml;base64,"),
    );
    ok("…not the company's favicon", tab.every((i) => i.url !== SQUARE_SVG));
    ok("the tag older iPhones read", (meta.other as Record<string, string>)["apple-mobile-web-app-capable"] === "yes");
    branding = BASE;
    ok("the same icons with no favicon", JSON.stringify((await pwa.appMetadata()).icons) === JSON.stringify(meta.icons));
    const root = readFileSync(path.join(__dirname, "../src/app/layout.tsx"), "utf8");
    ok("every other page's tab shows Deskzo's icon too", /icons: deskzoFavicons\(\)/.test(root) && !/faviconDataUrl/.test(root));

    const layout = readFileSync(path.join(__dirname, "../src/app/(dashboard)/layout.tsx"), "utf8");
    const login = readFileSync(path.join(__dirname, "../src/app/(auth)/login/page.tsx"), "utf8");
    ok("the signed-in pages carry it, and register the worker", /export const generateMetadata = appMetadata;/.test(layout) && /<InstallApp /.test(layout));
    ok("the sign-in page carries it", /export const generateMetadata = appMetadata;/.test(login));
    const publicLayout = readFileSync(path.join(__dirname, "../src/app/(public)/layout.tsx"), "utf8");
    ok("a customer's public pages don't (a form or portal is not this app)", !/appMetadata|InstallApp/.test(publicLayout));
    ok("the install hint draws nothing on the server (it is a fact about the phone)", renderToStaticMarkup(createElement(InstallApp, { appName: "Acme", hint: true })) === "");
  }

  section("The proxy");
  {
    const proxy = readFileSync(path.join(__dirname, "../src/proxy.ts"), "utf8");
    const prefixes = /const PUBLIC_PREFIXES = \[([^\]]*)\]/.exec(proxy)?.[1] ?? "";
    ok("/sw.js reached with nobody signed in", /"\/sw\.js"/.test(prefixes));
    ok("the manifest and icons are under /api, which needs no session", pwa.PWA_MANIFEST_PATH.startsWith("/api/") && /if \(api\) return NextResponse\.next\(\);/.test(proxy));
  }

  section("The service worker, in a stand-in browser");
  {
    const ORIGIN = "https://acme.deskzo.com";
    const source = readFileSync(path.join(__dirname, "../public/sw.js"), "utf8");
    ok("stores nothing but the manifest", !/cache\.put\(/.test(source) && (source.match(/cache\.add\(/g) ?? []).length === 1 && /cache\.add\(new Request\(MANIFEST/.test(source));

    class At extends Request {
      constructor(input: string | Request, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
      }
    }
    const stores = new Map<string, Map<string, Response>>([["an-older-version", new Map()]]);
    const urlOf = (r: string | Request) => (typeof r === "string" ? new URL(r, ORIGIN).href : r.url);
    const caches = {
      open: async (name: string) => {
        const store = stores.get(name) ?? new Map<string, Response>();
        stores.set(name, store);
        return { add: async (request: Request) => void store.set(request.url, await fetchStub(request)) };
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      match: async (request: string | Request) => {
        for (const store of stores.values()) {
          const hit = store.get(urlOf(request));
          if (hit) return hit.clone();
        }
        return undefined;
      },
    };
    let online = true;
    const fetched: string[] = [];
    async function fetchStub(request: Request): Promise<Response> {
      fetched.push(request.url);
      if (!online) throw new TypeError("Failed to fetch");
      if (request.url.endsWith("/api/pwa/manifest")) return Response.json({ name: 'Acme <b>"&', theme_color: "#0f766e" });
      return new Response("the page, from the server", { status: 200 });
    }
    const listeners: Record<string, (event: unknown) => void> = {};
    let preloadOn = false;
    const self = {
      addEventListener: (type: string, fn: (event: unknown) => void) => (listeners[type] = fn),
      skipWaiting: () => undefined,
      registration: { navigationPreload: { enable: async () => void (preloadOn = true) } },
      clients: { claim: async () => undefined },
    };
    vm.runInNewContext(source, { self, caches, fetch: fetchStub, Request: At, Response, URL, console });

    const waits: Promise<unknown>[] = [];
    listeners.install({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    ok("installing keeps the manifest", !!(await caches.match("/api/pwa/manifest")));
    listeners.activate({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    ok("activating drops older versions' stores", !stores.has("an-older-version") && stores.has("deskzo-app-1"));
    ok("…and asks for the page while the worker wakes", preloadOn);

    async function open(request: { mode: string; method: string; url: string }) {
      let answer: Promise<Response> | null = null;
      listeners.fetch({ request, preloadResponse: Promise.resolve(undefined), respondWith: (p: Promise<Response>) => (answer = p) });
      return answer ? await (answer as Promise<Response>) : null;
    }
    const page = { mode: "navigate", method: "GET", url: `${ORIGIN}/dashboard` };
    const before = stores.get("deskzo-app-1")!.size;
    const live = await open(page);
    ok("online, a page is the server's", live?.status === 200 && (await live.text()) === "the page, from the server");
    ok("…and isn't kept", stores.get("deskzo-app-1")!.size === before);
    ok("data, files and actions are left to the browser", (await open({ mode: "cors", method: "GET", url: `${ORIGIN}/api/app/today` })) === null && (await open({ mode: "navigate", method: "POST", url: `${ORIGIN}/login` })) === null);

    online = false;
    const offline = await open(page);
    const html = offline ? await offline.text() : "";
    ok("offline, the offline screen instead of the browser's error", offline?.status === 503 && /You're offline/.test(html));
    ok("…named for the workspace, its name escaped", html.includes("Acme &lt;b&gt;&quot;&amp;") && !html.includes("<b>"));
    ok("…never kept", offline?.headers.get("cache-control") === "no-store");
  }

  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
