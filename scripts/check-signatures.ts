/**
 * Deskzo Signatures (docs/digital-cards-and-signatures.md §5) — the templates, the free/premium line,
 * and the in-app signature, through the real code.
 *
 *   · **Safe HTML.** Every value escaped; a link only when it is http(s), a checked mailto: or tel:;
 *     nothing a mail client would strip or run.
 *   · **Premium stays premium.** The public page is given the free layouts and premium *names* only;
 *     no client file reaches the premium layouts; the preview route draws only premium templates and
 *     answers with a PNG, never HTML; the free output carries "Made with Deskzo", the paid one doesn't.
 *   · **A signature is the record's.** Name, title, phone, office from the record; a photo only through
 *     a token that can't be guessed or bent to another person; a card link only while the card is live.
 *   · **The company decides.** A locked template can't be changed by a person; only signatures.manage
 *     changes the settings; a banner link must be a web address.
 *
 * Against the development database, through a direct client, with ZZPROBE_SIG fixtures removed in a
 * finally.
 *
 *   npm run check:signatures
 */
import "dotenv/config";
import Module from "node:module";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
let actorId = "";
let mayManage = false;
let cardsOn = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/db") return { db };
  if (request === "@/lib/audit") return { recordAudit: async () => {} };
  if (request === "@/lib/crypto") return { digestSecret: async (v: string) => createHmac("sha256", "zz-probe-key").update(v).digest("base64") };
  if (request === "@/lib/tenancy/resolve") return { tenantOrigin: async () => "https://acme.deskzo.test" };
  if (request === "@/lib/time/workspace") return { workspaceClock: async () => ({ today: () => new Date().toISOString().slice(0, 10) }) };
  if (request === "@/actions/permission") return { hasEffectivePermission: async (_u: string, key: string) => (key === "signatures.manage" ? mayManage : true) };
  if (request === "@/lib/modules-access") return { requireModuleUser: async () => ({ id: actorId }), moduleAvailableForTenant: async (key: string) => key !== "cards" || cardsOn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/* eslint-disable @typescript-eslint/no-require-imports */
const render = require("../src/lib/signatures/render") as typeof import("../src/lib/signatures/render");
const premium = require("../src/lib/signatures/premium") as typeof import("../src/lib/signatures/premium");
const server = require("../src/lib/signatures/server") as typeof import("../src/lib/signatures/server");
const actions = require("../src/actions/signatures") as typeof import("../src/actions/signatures");
const previewRoute = require("../src/app/platform-site/email-signature-generator/preview/route") as typeof import("../src/app/platform-site/email-signature-generator/preview/route");
/* eslint-enable @typescript-eslint/no-require-imports */

const TAG = "ZZPROBE_SIG";
const ROOT = join(__dirname, "..");
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: TAG.toLowerCase() } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.userSignature.deleteMany({ where: { userId: { in: ids } } });
  await db.digitalCard.deleteMany({ where: { userId: { in: ids } } });
  await db.cardTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.userPhoto.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.signatureSettings.deleteMany({ where: { id: "global", updatedById: { in: ids } } });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function pure() {
  section("Safe HTML");
  const hostile = {
    name: `<script>alert(1)</script> "Priya"`,
    title: `<img src=x onerror=alert(1)>`,
    email: `priya@acme.example"><script>`,
    website: "javascript:alert(1)",
    phone: "+91 98765 43210",
    socials: { linkedin: "javascript:alert(2)", x: "x.com/priya" },
    logoUrl: "javascript:alert(3)",
    banner: { imageUrl: "data:image/png;base64,AAAA", link: "javascript:alert(4)" },
  };
  // Only what is inside a tag can run: an event handler, or a link or image to a script or data URL.
  // The same words as escaped text are just words.
  const dangerous = (html: string) => {
    const tags = html.match(/<[^>]*>/g) ?? [];
    return tags.filter((t) => /^<\s*(script|iframe|object|embed)/i.test(t) || /\son\w+\s*=/i.test(t) || /(href|src)\s*=\s*"\s*(javascript|data|vbscript):/i.test(t) || /<img src="x"/i.test(t));
  };
  const found = premium.ALL_LAYOUTS.flatMap((l) => dangerous(render.renderSignatureHtml(l, hostile)).map((t) => `${l.name}: ${t}`));
  ok("no template turns a typed value into markup or a script link", found.length === 0, found.slice(0, 3).join(" | "));
  ok("  and the same check catches what it should", dangerous('<a href="javascript:x">').length === 1 && dangerous('<img src=y onerror=z>').length === 1);
  const simple = render.renderSignatureHtml(render.FREE_LAYOUTS[0]!, hostile);
  ok("  the name is shown, escaped", simple.includes("&lt;script&gt;alert(1)&lt;/script&gt; &quot;Priya&quot;"));
  ok("  a real phone is a tel: link, a broken email is text", simple.includes('href="tel:+919876543210"') && !simple.includes("mailto:"));
  ok("  a bare domain becomes https", render.safeUrl("acme.in") === "https://acme.in/" && render.safeUrl("ftp://x.example") === null);
  ok("mail-client markup: tables and inline styles, no classes", !/class=/.test(render.renderSignatureHtml(premium.ALL_LAYOUTS[0]!, render.SAMPLE_SIGNATURE)) && /<table/.test(simple));

  section("Premium stays premium");
  ok("4 free and 8 premium templates", render.FREE_LAYOUTS.length === 4 && premium.PREMIUM_LAYOUTS.length === 8 && render.FREE_LAYOUTS.every((l) => l.tier === "free") && premium.PREMIUM_LAYOUTS.every((l) => l.tier === "premium"));
  ok("  every premium template has its teaser, by key and name", premium.PREMIUM_LAYOUTS.every((l, i) => render.PREMIUM_TEASERS[i]?.key === l.key && render.PREMIUM_TEASERS[i]?.name === l.name));
  ok("  keys are unique", new Set(premium.ALL_LAYOUTS.map((l) => l.key)).size === 12);
  ok("  a teaser carries no layout", render.PREMIUM_TEASERS.every((t) => Object.keys(t).sort().join() === "blurb,key,name"));
  const clientFiles = walk(join(ROOT, "src")).filter((f) => /^["']use client["']/m.test(readFileSync(f, "utf8").slice(0, 200)));
  const leaking = clientFiles.filter((f) => /signatures\/(premium|preview|server)["']/.test(readFileSync(f, "utf8")));
  ok("no client file imports the premium layouts, the preview drawer or the server code", leaking.length === 0, leaking.map((f) => relative(ROOT, f)).join(", ") || `${clientFiles.length} client files`);
  const page = readFileSync(join(ROOT, "src/app/platform-site/email-signature-generator/page.tsx"), "utf8");
  ok("  the public page hands its client the free layouts and the premium teasers only", /freeLayouts=\{\[\.\.\.FREE_LAYOUTS\]\}/.test(page) && /premium=\{\[\.\.\.PREMIUM_TEASERS\]\}/.test(page) && !/PREMIUM_LAYOUTS|ALL_LAYOUTS/.test(page));
  const made = { href: "https://deskzo.com/email-signature-generator", label: "Made with Deskzo" };
  ok("free output can carry the Made with Deskzo line", render.renderSignatureHtml(render.FREE_LAYOUTS[0]!, render.SAMPLE_SIGNATURE, { madeWith: made }).includes("Made with Deskzo"));
  ok("  and output without it has none", !render.renderSignatureHtml(premium.PREMIUM_LAYOUTS[0]!, render.SAMPLE_SIGNATURE).includes("Made with"));

  section("Registered everywhere it must be");
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  ok("the module, its permission and section", /key: "signatures",/.test(read("src/lib/modules.ts")) && ['key: "signatures.manage"', 'key: "section.signatures"'].every((k) => read("src/lib/permissions.ts").includes(k)));
  ok("  its actions are mapped", /"signatures\.ts": \["signatures"\]/.test(read("src/lib/module-actions.ts")));
  ok("  and /sig is a public path", /PUBLIC_PREFIXES = \[[^\]]*"\/sig"/.test(read("src/proxy.ts")));
}

async function previews() {
  section("The preview route draws premium templates only, as a picture");
  const call = (q: string) => previewRoute.GET(new Request(`https://deskzo.test/email-signature-generator/preview?${q}`));
  const d = Buffer.from(JSON.stringify({ name: "Asha Rao", title: "CTO" })).toString("base64url");
  const img = await call(`t=portrait&d=${d}`);
  const bytes = Buffer.from(await img.arrayBuffer());
  ok("a premium template comes back as a PNG", img.status === 200 && img.headers.get("content-type") === "image/png" && bytes.subarray(1, 4).toString() === "PNG");
  ok("  a free one isn't drawn here", (await call("t=simple")).status === 404);
  ok("  nor a template that doesn't exist", (await call("t=nope")).status === 404);
  ok("  junk or oversized details fall back to the example", (await call("t=portrait&d=%%%")).status === 200 && (await call(`t=portrait&d=${"A".repeat(9000)}`)).status === 200);
  // Fonts and emoji the bundled font lacks would be fetched from the web, with the visitor's text in the request.
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    fetched += 1;
    return realFetch(...args);
  }) as typeof fetch;
  try {
    const wide = Buffer.from(JSON.stringify({ name: "प्रिया शर्मा 🙂", title: "Directora de Ventas · São Paulo", company: "株式会社" })).toString("base64url");
    const r = await call(`t=legal&d=${wide}`);
    await r.arrayBuffer();
    ok("  drawing non-Latin text and emoji fetches nothing from the web", r.status === 200 && fetched === 0, `${fetched} fetch(es)`);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function withDb() {
  section("A signature is the record's");
  await cleanup();
  const person = await db.user.create({ data: { name: `${TAG} Person`, email: `${TAG.toLowerCase()}-p@example.com`, role: "SALES", phone: "+91 90000 00002", passwordHash: "!", photoUpdatedAt: new Date() } });
  const other = await db.user.create({ data: { name: `${TAG} Other`, email: `${TAG.toLowerCase()}-o@example.com`, role: "SALES", passwordHash: "!" } });
  await db.employeeProfile.create({ data: { userId: person.id, designation: "Head of Sales", personalPhone: "+91 99999 99999" } });
  await db.userPhoto.create({ data: { userId: person.id, dataUrl: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", byteSize: 8 } });
  actorId = person.id;

  const settings = server.DEFAULT_SIGNATURE_SETTINGS;
  const data = await server.signatureDataFor(person.id, settings, "https://acme.deskzo.test");
  ok("name, title, work phone and email come from the record", data?.name === person.name && data?.title === "Head of Sales" && data?.phone === "+91 90000 00002" && data?.email === person.email);
  ok("  never the personal phone", !JSON.stringify(data).includes("99999 99999"));
  ok("  the photo through a token", !!data?.photoUrl?.startsWith("https://acme.deskzo.test/sig/p/"));
  const token = await server.photoToken(person.id);
  ok("the token opens that person's photo", (await server.userFromPhotoToken(token)) === person.id);
  ok("  a tampered one opens nothing", (await server.userFromPhotoToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)) === null);
  ok("  nor does one person's MAC on another's id", (await server.userFromPhotoToken(`${other.id}.${token.split(".")[1]}`)) === null);
  ok("no live card, no card link", !data?.cardUrl);
  const tpl = await db.cardTemplate.create({ data: { name: `${TAG} t`, fields: [] } });
  await db.digitalCard.create({ data: { userId: person.id, templateId: tpl.id, slug: "zzprobe-sig-person" } });
  ok("  a live card is linked, with its QR", (await server.signatureDataFor(person.id, settings, "https://x.test"))?.qrUrl === "https://x.test/c/zzprobe-sig-person/qr");
  cardsOn = false;
  ok("  nor while the Cards module is off", !(await server.signatureDataFor(person.id, settings, "https://x.test"))?.cardUrl);
  cardsOn = true;
  await db.digitalCard.update({ where: { userId: person.id }, data: { active: false } });
  ok("  and a switched-off one isn't", !(await server.signatureDataFor(person.id, settings, "https://x.test"))?.cardUrl);

  section("The company decides");
  mayManage = false;
  ok("only signatures.manage changes the company's signature", !(await actions.saveSignatureSettings({ ...settings, website: "", disclaimer: "", bannerImageUrl: "", bannerLink: "" })).ok);
  mayManage = true;
  const base = { templateKey: "portrait", lockTemplate: true, accentColor: "#0d9488", website: "acme.example", socials: {}, disclaimer: "Confidential.", bannerImageUrl: "", bannerLink: "", showPhoto: true, showCard: true };
  ok("  a banner link must be a web address", !(await actions.saveSignatureSettings({ ...base, bannerLink: "javascript:alert(1)" })).ok);
  ok("  a social link too", !(await actions.saveSignatureSettings({ ...base, socials: { linkedin: "javascript:x" } })).ok);
  ok("  a template that doesn't exist is refused", !(await actions.saveSignatureSettings({ ...base, templateKey: "nope" })).ok);
  ok("  a manager locks a premium template for everybody", (await actions.saveSignatureSettings(base)).ok);
  mayManage = false;
  const locked = await actions.getMySignature();
  ok("a person then gets that template, and only it to choose", locked.ok && locked.data.selectedKey === "portrait" && locked.data.locked && locked.data.choices.length === 1 && locked.data.settings === null);
  ok("  can't pick another", !(await actions.updateMySignature({ templateKey: "simple", mobile: "" })).ok);
  ok("  but can add their own mobile", (await actions.updateMySignature({ templateKey: null, mobile: "+91 98888 77777" })).ok && (await actions.getMySignature()).ok);
  const withMobile = await actions.getMySignature();
  ok("  which their signature shows", withMobile.ok && withMobile.data.html.includes("+91 98888 77777"));
  ok("  in the paid output, no Made with line", withMobile.ok && !withMobile.data.html.includes("Made with"));
  mayManage = true;
  await actions.saveSignatureSettings({ ...base, lockTemplate: false });
  mayManage = false;
  ok("unlocked, a person may pick any of the twelve", (await actions.updateMySignature({ templateKey: "centered", mobile: "" })).ok && (await actions.getMySignature()).ok);
  const picked = await actions.getMySignature();
  ok("  and their pick is their signature", picked.ok && picked.data.selectedKey === "centered" && picked.data.choices.length === 12);
  await actions.updateMySignature({ mobile: "+91 97777 66666" });
  const kept = await actions.getMySignature();
  ok("  saving only a mobile leaves their pick alone", kept.ok && kept.data.selectedKey === "centered" && kept.data.html.includes("97777 66666"));
  await actions.updateMySignature({ templateKey: null, mobile: "" });
  const back = await actions.getMySignature();
  ok("  and clearing it goes back to the company's template", back.ok && back.data.selectedKey === "portrait");
}

async function main() {
  pure();
  await previews();
  const existing = await db.signatureSettings.findUnique({ where: { id: "global" } });
  try {
    await withDb();
  } finally {
    await cleanup().catch((e) => console.log(" FAIL  cleanup —", e));
    // A workspace's own settings, if the check found some, are put back as they were.
    if (existing) await db.signatureSettings.upsert({ where: { id: "global" }, create: existing as never, update: existing as never });
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll signature checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
