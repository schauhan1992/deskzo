/**
 * Mass mail — HTML templates, uploaded lists, and the email that actually leaves.
 *
 *   · Without a database: cleaning uploaded HTML (what goes, what stays), plain text into HTML and
 *     back, merged values escaped, the finished email — preheader, footer, pixel, tracked links,
 *     hosted pictures — reading a .zip (its pictures found, fakes and SVG and bombs refused), and
 *     reading a CSV list.
 *   · Through the real code: uploading a template (and who may, and from where), serving its
 *     pictures, uploading a list (contacts matched and created, companies found, consent recorded
 *     but never over an unsubscribe, addresses checked), sending to it in one step, what each
 *     queued email holds, sending, the campaign settling to Sent, opens and clicks, one-click
 *     unsubscribe, the report, and a test send to yourself.
 *
 * Nothing goes on the wire: the providers are stubbed, and so is the address check's DNS. Every
 * fixture is named ZZMM and removed in a finally.
 *
 *   npm run check:mass-mail
 */
import "dotenv/config";
import Module from "node:module";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { absolutiseAssets, composeEmail, escapeHtml, htmlToText, removedInCleaning, rewriteLinks, sanitizeEmailHtml, textToHtml } from "../src/lib/marketing/html";
import { render } from "../src/lib/marketing/merge";
import { extractInlineImages, normalisePath, readTemplateUpload, rewriteImageRefs, sniffImage } from "../src/lib/marketing/template-upload";
import { previewDocument } from "../src/lib/marketing/preview";
import { normalizeCompanyName } from "../src/lib/company-name";

let actorId = "";
const sent: { to: string; subject: string; html: string; text?: string; listUnsubscribe?: string | null }[] = [];
const fakeProvider = {
  key: "fake",
  kind: "EMAIL",
  async send(m: { to: string; subject: string; html: string; text?: string; listUnsubscribe?: string | null }) {
    sent.push(m);
    return { ok: true as const, providerMessageId: `zzmm-${sent.length}` };
  },
  async verify() {
    return { ok: true, detail: "fake" };
  },
};
const ORIGIN = "https://crm.zzmm.test";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => new Headers({ host: "crm.zzmm.test", "x-forwarded-proto": "https" }), cookies: async () => ({ get: () => undefined }) };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzmm", email: `x${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user() };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  // Every provider is the fake one — whatever the database says is configured, nothing leaves.
  if (request === "@/lib/marketing/providers") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, providerByKey: new Proxy({}, { get: () => fakeProvider }) };
  }
  // The address check, without DNS: a gmail address is a free mailbox, anything with "bounce" fails.
  if (request === "@/lib/email-verification-lookup") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      checkEmailAddress: async (email: string) =>
        /bounce/.test(email)
          ? { status: "INVALID", detail: "zzmm: no mailbox" }
          : /@gmail\.com$/.test(email)
            ? { status: "RISKY", detail: "zzmm: free mailbox" }
            : { status: "VALID", detail: "zzmm: fine" },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = new PrismaClient();
const TAG = "ZZMM";
const MAIL = "@zzprobe-massmail.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

// A real 1×1 PNG and GIF, so the byte check has something true to find.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const templates = await db.marketingTemplate.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }] }, select: { id: true } });
  await db.campaign.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }] } });
  await db.marketingAsset.deleteMany({ where: { OR: [{ templateId: { in: templates.map((t) => t.id) } }, { createdById: { in: userIds } }] } });
  await db.marketingTemplate.deleteMany({ where: { id: { in: templates.map((t) => t.id) } } });
  await db.marketingList.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }] } });
  const contacts = await db.contact.findMany({ where: { email: { contains: "zzmm", mode: "insensitive" } }, select: { id: true } });
  await db.marketingMessage.deleteMany({ where: { contactId: { in: contacts.map((c) => c.id) } } });
  await db.suppression.deleteMany({ where: { value: { contains: "zzmm" } } });
  await db.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } });
  const companies = await db.company.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }, { name: { contains: "zzmm" } }] }, select: { id: true } });
  await db.marketingMessage.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies.map((c) => c.id) } } });
  await db.company.deleteMany({ where: { id: { in: companies.map((c) => c.id) } } });
  await db.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  // ─────────────────────────────────────────────────────────────────────────────
  section("Cleaning uploaded HTML");

  const dirty = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel="stylesheet" href="https://evil.example/x.css"><style>.x{color:red} @import url(evil.css); .y{width:expression(alert(1))}</style><script>alert(1)</script></head>
<body><table width="600" bgcolor="#ffffff" align="center" cellpadding="4"><tr><td style="color:#333;background:url(javascript:alert(1))">
<h1 onclick="steal()" style="font-size:22px">Hi {{firstName|there}}</h1><a href="{{unsubscribeUrl}}">Unsubscribe</a>
<a href="javascript:alert(1)">bad</a><a href="https://ok.example/?a=1&amp;b=2">good</a><img src="https://cdn.example/x.png" alt="x"><img src="data:image/png;base64,AAAA">
<form action="https://evil.example"><input name="card"></form><iframe src="https://evil.example"></iframe><svg><script>x()</script></svg><object data="x.swf"></object>
</td></tr></table></body></html>`;
  const clean = sanitizeEmailHtml(dirty);
  ok("scripts, frames, forms, objects and SVG are gone", !/<(script|iframe|form|input|svg|object)\b/i.test(clean), clean.slice(0, 80));
  ok("  and every event handler and javascript: link", !/\son[a-z]+\s*=/i.test(clean) && !/javascript:/i.test(clean));
  ok("  and the redirecting meta, the <base>, the stylesheet link", !/http-equiv|<base\b|<link\b/i.test(clean));
  ok("  and the CSS that has ever run code", !/expression\s*\(|@import/i.test(clean));
  ok("a layout survives: tables with their attributes, inline styles, a <style> block", /<table[^>]*width="600"[^>]*bgcolor="#ffffff"/.test(clean) && clean.includes("font-size:22px") && /<style>[^<]*color:red/.test(clean));
  ok("  web pictures and links stay, a data: picture doesn't", clean.includes('src="https://cdn.example/x.png"') && !clean.includes("data:image") && clean.includes('href="https://ok.example/?a=1&amp;b=2"'));
  ok("  merge fields survive, in text and in a link", clean.includes("{{firstName|there}}") && clean.includes('href="{{unsubscribeUrl}}"'));
  const removed = removedInCleaning(dirty, clean);
  ok("what was removed is counted, to tell the author", removed.some((r) => r.includes("scripts")) && removed.some((r) => r.includes("event handlers")) && removed.some((r) => r.includes("forms")), removed.join("; "));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Text, HTML and the merge");

  const asHtml = textToHtml("Hi Asha & co,\n\nSee <this>: https://zzmm.example/offer.\nThanks");
  ok("plain text becomes escaped paragraphs, its line breaks kept", asHtml.includes("Hi Asha &amp; co,") && asHtml.includes("&lt;this&gt;") && (asHtml.match(/<p /g) ?? []).length === 2 && asHtml.includes("<br>"));
  ok("  and a bare link becomes a link — without the full stop after it", asHtml.includes('<a href="https://zzmm.example/offer">https://zzmm.example/offer</a>.'));
  const back = htmlToText('<p>Hello &amp; welcome</p><p><a href="https://x.example/a?b=1&amp;c=2">Read more</a></p><style>.x{}</style>');
  ok("HTML back into text keeps a link's address", back === "Hello & welcome\nRead more (https://x.example/a?b=1&c=2)", JSON.stringify(back));
  const merged = render("<p>{{companyName}} — {{firstName|<b>friend</b>}}</p>", { companyName: "A & B <x>" }, { escape: escapeHtml });
  ok("a merged value is escaped in HTML; the author's own fallback is not", merged.ok && merged.text === "<p>A &amp; B &lt;x&gt; — <b>friend</b></p>", merged.ok ? merged.text : "");

  // ─────────────────────────────────────────────────────────────────────────────
  section("The email that leaves");

  const footer = { senderName: "Wroffy", unsubscribeUrl: `${ORIGIN}/preferences/tok`, postalAddress: "1 MG Road, Pune", includeUnsubscribe: true, includeAddress: true };
  const tracked: string[] = [];
  const track = { openPixelUrl: `${ORIGIN}/track/tok`, link: (url: string) => (tracked.push(url), `${ORIGIN}/track/tok?u=${encodeURIComponent(url)}`) };
  const plain = composeEmail({ format: "TEXT", body: "Hi Asha,\n\nOffer: https://zzmm.example/offer", preheader: "Just for you", footer, origin: ORIGIN, track });
  ok("a text email is wrapped in a page, with its preheader hidden up top", plain.html.startsWith("<!doctype html>") && /display:none[^>]*>Just for you</.test(plain.html));
  ok("  a footer with the unsubscribe link and the postal address", plain.html.includes(`href="${ORIGIN}/preferences/tok"`) && plain.html.includes("1 MG Road, Pune"));
  ok("  the open pixel, last", /<img src="https:\/\/crm\.zzmm\.test\/track\/tok"[^>]*><\/body>/.test(plain.html));
  ok("  its link through the tracker — and the unsubscribe link left alone", tracked.includes("https://zzmm.example/offer") && !tracked.some((u) => u.includes("/preferences/")) && plain.html.includes("/track/tok?u=https%3A%2F%2Fzzmm.example%2Foffer"));
  ok("  and a text part of its own, footer included", plain.text.startsWith("Hi Asha,") && plain.text.includes(`Unsubscribe or choose what you hear about: ${ORIGIN}/preferences/tok`));
  const doc = composeEmail({
    format: "HTML",
    body: `<html><head><title>x</title></head><body style="margin:0"><p>Hello</p><img src="/api/marketing/assets/ma1/logo.png"><div style="background:url(/api/marketing/assets/ma2/bg.png)"></div><a href="mailto:a@b.c">mail</a></body></html>`,
    preheader: "Pre",
    footer: { ...footer, includeUnsubscribe: false },
    origin: ORIGIN,
    track,
  });
  ok("a whole HTML document keeps its own body: preheader first inside it, footer and pixel last", /<body style="margin:0"><div style="display:none/.test(doc.html) && /1 MG Road, Pune[\s\S]*<img src="https:\/\/crm\.zzmm\.test\/track\/tok"[^>]*><\/body>/.test(doc.html) && doc.html.startsWith("<!doctype html>"));
  ok("  our pictures get absolute addresses, in src and in CSS", doc.html.includes(`src="${ORIGIN}/api/marketing/assets/ma1/logo.png"`) && doc.html.includes(`url(${ORIGIN}/api/marketing/assets/ma2/bg.png)`));
  ok("  an author's own unsubscribe link means no second one in the footer", !doc.html.includes("Unsubscribe or choose"));
  ok("  mailto: links aren't tracked", doc.html.includes('href="mailto:a@b.c"'));
  const amp = rewriteLinks('<a href="https://x.example/?a=1&amp;b=2">x</a>', (u) => `T:${u}`);
  ok("a link's &amp; is the real & to the tracker, and escaped again in the page", amp === '<a href="T:https://x.example/?a=1&amp;b=2">x</a>', amp);
  ok("a root-relative asset path is only ever ours", absolutiseAssets('<img src="/other/x.png"><img src="/api/marketing/assets/a/b.png">', ORIGIN) === `<img src="/other/x.png"><img src="${ORIGIN}/api/marketing/assets/a/b.png">`);
  const pv = previewDocument(plain.html);
  ok("a preview has no pixel, and its links can't go anywhere", !pv.includes("/track/tok\"") && pv.includes('<base target="_blank">'));

  // ─────────────────────────────────────────────────────────────────────────────
  section("Reading an upload");

  ok("pictures are known by their bytes, not their names", sniffImage(PNG) === "image/png" && sniffImage(JPG) === "image/jpeg" && sniffImage(Buffer.from("<svg>")) === null);
  ok("a path can't climb out of the archive", normalisePath("a/../../etc/passwd") === null && normalisePath("email/./images/../images/x.png") === "email/images/x.png");
  const zip = new JSZip();
  zip.file("email/index.html", `<html><body><td background="images/bg.png" style="background:url('images/bg.png')"><img src="images/logo.png"><img src="images/Hero%20Pic.jpg"><img src="images/missing.png"><img src="https://cdn.example/web.png"><img src="data:image/png;base64,${PNG.toString("base64")}"></td></body></html>`);
  zip.file("email/images/logo.png", PNG);
  zip.file("email/images/bg.png", PNG);
  zip.file("email/images/Hero Pic.jpg", JPG);
  zip.file("email/images/icon.svg", "<svg><script>x()</script></svg>");
  zip.file("email/images/fake.png", "not really a png");
  zip.file("email/images/huge.png", Buffer.concat([PNG, Buffer.alloc(2.5 * 1024 * 1024)]));
  zip.file("__MACOSX/email/._index.html", "junk");
  zip.file("email/other.html", "<p>not the email</p>");
  const read = await readTemplateUpload("campaign.zip", await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  ok("a .zip's email is found — index.html, not a stray page", read.ok && read.htmlPath === "email/index.html", read.ok ? read.htmlPath : read.error);
  if (read.ok) {
    ok("  its real pictures are taken", read.images.map((i) => i.path).sort().join() === "email/images/Hero Pic.jpg,email/images/bg.png,email/images/logo.png", read.images.map((i) => i.path).join());
    ok("  SVG, a fake picture and an oversized one are left out, and said so", read.skipped.length === 3 && read.skipped.some((s) => s.includes("icon.svg")) && read.skipped.some((s) => s.includes("fake.png")) && read.skipped.some((s) => s.includes("over 2 MB")), read.skipped.join(" | "));
    const inline = extractInlineImages(read.html);
    ok("a data: picture is lifted out into an upload of its own", inline.images.length === 1 && inline.images[0]!.mimeType === "image/png" && !inline.html.includes("data:image"));
    const known = new Map([...read.images.map((i) => i.path), `email/${inline.images[0]!.path}`].map((p) => [p, `/api/marketing/assets/X/${encodeURIComponent(p.split("/").pop()!)}`]));
    const refs = rewriteImageRefs(inline.html, read.htmlPath, (p) => known.get(p) ?? null);
    ok("  every reference is pointed at its hosted copy — src, background, CSS url(), a space in the name", refs.html.includes('src="/api/marketing/assets/X/logo.png"') && refs.html.includes('background="/api/marketing/assets/X/bg.png"') && refs.html.includes("url('/api/marketing/assets/X/bg.png')") && refs.html.includes("Hero%20Pic.jpg") && refs.html.includes("inline-1.png"));
    ok("  a picture that isn't there is reported; a web picture is left alone", refs.missing.join() === "images/missing.png" && refs.html.includes('src="https://cdn.example/web.png"'), refs.missing.join());
  }
  const bomb = new JSZip();
  bomb.file("index.html", "<p>hi</p>");
  bomb.file("zeros.png", Buffer.alloc(41 * 1024 * 1024));
  const bombRead = await readTemplateUpload("bomb.zip", await bomb.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  ok("a .zip that would inflate past 40 MB is refused before it's read", !bombRead.ok && bombRead.error.includes("40 MB"), bombRead.ok ? "" : bombRead.error);
  ok("a file that is neither .html nor .zip is refused", !(await readTemplateUpload("x.pdf", Buffer.from("x"))).ok);

  // ─────────────────────────────────────────────────────────────────────────────
  section("Reading a list");

  // Required here, after the stubs are in place — a static import runs before them, and this module
  // pulls in the address check that has to be the stubbed one.
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { companyNameFromDomain, designationFrom, parseListCsv } = require("../src/lib/marketing/list-import") as typeof import("../src/lib/marketing/list-import");

  const csv = parseListCsv('﻿E-mail,Full Name,Organisation,Mobile,Job Title\nasha@acme.example,Asha Rao,Acme,99999,IT Manager\n,,,,\nnot-an-email,X,,,\nASHA@acme.example,Dup,,,\nravi@gmail.com,Ravi,,,');
  ok("columns found by any common name, a byte-order mark ignored", csv.columns.email === "E-mail" && csv.columns.name === "Full Name" && csv.columns.company === "Organisation" && csv.columns.phone === "Mobile" && csv.columns.designation === "Job Title");
  ok("  addresses lower-cased; the bad one reported, the repeat counted once, the blank line ignored", csv.rows.map((r) => r.email).join() === "asha@acme.example,ravi@gmail.com" && csv.invalid.length === 1 && csv.invalid[0]!.value === "not-an-email" && csv.duplicates === 1, JSON.stringify(csv.invalid));
  const split = parseListCsv("Email,First name,Last name\nx@y.example,Asha,Rao");
  ok("  first and last name joined when there is no name column", split.rows[0]?.name === "Asha Rao");
  ok("a domain as a company name", companyNameFromDomain("sales.acme.co.in") === "acme.co.in" && companyNameFromDomain("mail.acme.com") === "acme.com");
  ok("job titles onto the CRM's designations", designationFrom("Chief Information Officer") === "CIO" && designationFrom("IT Manager") === "IT_MANAGER" && designationFrom("Head of Procurement") === "PURCHASE_MANAGER" && designationFrom("Florist") === "OTHER");

  // ─────────────────────────────────────────────────────────────────────────────
  /* eslint-disable @typescript-eslint/no-require-imports */
  const marketing = require("../src/actions/marketing") as typeof import("../src/actions/marketing");
  const pipeline = require("../src/lib/marketing/pipeline") as typeof import("../src/lib/marketing/pipeline");
  const uploadTemplateRoute = require("../src/app/api/marketing/templates/upload/route") as typeof import("../src/app/api/marketing/templates/upload/route");
  const uploadListRoute = require("../src/app/api/marketing/lists/upload/route") as typeof import("../src/app/api/marketing/lists/upload/route");
  const assetRoute = require("../src/app/api/marketing/assets/[id]/[name]/route") as typeof import("../src/app/api/marketing/assets/[id]/[name]/route");
  const unsubscribeRoute = require("../src/app/api/marketing/unsubscribe/[token]/route") as typeof import("../src/app/api/marketing/unsubscribe/[token]/route");
  const trackRoute = require("../src/app/track/[token]/route") as typeof import("../src/app/track/[token]/route");

  const post = (url: string, form: FormData, origin = "https://crm.zzmm.test") =>
    new Request(`https://crm.zzmm.test${url}`, { method: "POST", headers: { origin, "x-forwarded-host": "crm.zzmm.test" }, body: form });

  await cleanup();
  try {
    const make = (name: string, grants: Record<string, boolean>) =>
      db.user.create({
        data: {
          name: `Zzmm ${name}`,
          email: `${name.toLowerCase()}${MAIL}`,
          role: "SALES",
          passwordHash: "x".repeat(60),
          permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) },
        },
      });
    const marketer = await make("Marketer", { "marketing.manage": true, "marketing.send": true, "marketing.viewAll": true, "marketing.approve": false });
    const builder = await make("Builder", { "marketing.manage": true, "marketing.send": false });
    const outsider = await make("Outsider", { "marketing.manage": false, "marketing.send": false, "marketing.viewAll": false });
    const as = (u: { id: string }) => {
      actorId = u.id;
    };

    // ───────────────────────────────────────────────────────────────────────────
    section("Uploading a template");

    const templateZip = new JSZip();
    templateZip.file("index.html", `<!doctype html><html><head><style>.btn{color:#fff}</style><script>alert(1)</script></head><body><table width="600"><tr><td><img src="images/logo.png" alt="Logo"><h1 onclick="x()">Hello {{firstName|there}} at {{companyName}}</h1><p><a class="btn" href="https://zzmm.example/offer?a=1&amp;b=2">See the offer</a></p></td></tr></table></body></html>`);
    templateZip.file("images/logo.png", PNG);
    const zipBytes = await templateZip.generateAsync({ type: "nodebuffer" });
    const templateForm = () => {
      const f = new FormData();
      f.set("file", new File([new Uint8Array(zipBytes)], "diwali.zip", { type: "application/zip" }));
      f.set("name", `${TAG} Diwali`);
      f.set("topic", "OFFERS");
      f.set("subject", "{{firstName|Hello}}, your Diwali offer");
      f.set("preheader", "Inside: something for {{companyName|you}}");
      return f;
    };
    as(outsider);
    ok("somebody who can't build campaigns can't upload a template", (await uploadTemplateRoute.POST(post("/api/marketing/templates/upload", templateForm()))).status === 403);
    as(marketer);
    ok("  nor can a page on another site, with a marketer's cookie", (await uploadTemplateRoute.POST(post("/api/marketing/templates/upload", templateForm(), "https://evil.example"))).status === 403);
    const uploadResponse = await uploadTemplateRoute.POST(post("/api/marketing/templates/upload", templateForm()));
    const uploaded = (await uploadResponse.json()) as { ok: boolean; data: { id: string; warnings: string[]; body: string } };
    ok("a marketer uploads an HTML .zip and it becomes a template", uploaded.ok, JSON.stringify(uploaded).slice(0, 200));
    const template = await db.marketingTemplate.findUniqueOrThrow({ where: { id: uploaded.data.id }, include: { assets: true } });
    ok("  stored as HTML, cleaned — no script, no handler — its layout kept", template.format === "HTML" && !/<script|onclick/i.test(template.body) && template.body.includes('<table width="600">') && template.sourceFileName === "diwali.zip");
    ok("  and the author told what was taken out", uploaded.data.warnings.some((w) => w.includes("Removed for safety") && w.includes("1 scripts")), uploaded.data.warnings.join(" | "));
    ok("  its picture hosted, and the HTML pointing at it", template.assets.length === 1 && template.body.includes(`/api/marketing/assets/${template.assets[0]!.id}/logo.png`));
    const asset = await assetRoute.GET(new Request(`${ORIGIN}/api/marketing/assets/x`), { params: Promise.resolve({ id: template.assets[0]!.id, name: "logo.png" }) });
    const bytes = Buffer.from(await asset.arrayBuffer());
    ok("the picture is served to anybody, as the image it is, never sniffed as anything else", asset.status === 200 && asset.headers.get("content-type") === "image/png" && asset.headers.get("x-content-type-options") === "nosniff" && bytes.equals(PNG));
    ok("  and an id that isn't one is a 404", (await assetRoute.GET(new Request(`${ORIGIN}/x`), { params: Promise.resolve({ id: "nothing00000", name: "x.png" }) })).status === 404);

    ok("pasted HTML is cleaned the same way on save", await (async () => {
      const r = await marketing.saveTemplate({ name: `${TAG} Pasted`, channel: "EMAIL", topic: "OFFERS", subject: "Hi", body: '<p onclick="x()">Hi {{firstName|there}}</p><script>y()</script>', format: "HTML" });
      if (!r.ok) return false;
      const t = await db.marketingTemplate.findUnique({ where: { id: r.data.id } });
      return !!t && t.format === "HTML" && !/script|onclick/i.test(t.body) && r.data.warnings.some((w) => w.includes("Removed for safety"));
    })());
    const preview = await marketing.previewTemplate({ subject: template.subject ?? "", preheader: template.preheader ?? "", body: template.body, format: "HTML" });
    ok("the preview is the finished email: filled in, with its footer", !!preview.html && preview.html.includes("Hello Rajesh") && preview.html.includes("Unsubscribe or choose"), preview.problems.join());

    // ───────────────────────────────────────────────────────────────────────────
    section("Uploading a list");

    const colleagueCo = await db.company.create({ data: { name: `${TAG} Colleague & Co <Ltd>`, normalizedName: `${TAG} colleague and co ltd zz`.toLowerCase(), createdById: marketer.id, ownerUserId: marketer.id, relationshipType: "CLIENT", stage: "PROSPECT" } as never });
    await db.contact.create({ data: { companyId: colleagueCo.id, name: "Zzmm Old", email: "old@zzmm-colleague.example" } });
    const existing = await db.contact.create({ data: { companyId: colleagueCo.id, name: "Zzmm Existing", email: "Existing@ZZMM-colleague.example" } });
    const gone = await db.contact.create({ data: { companyId: colleagueCo.id, name: "Zzmm Gone", email: "gone@zzmm-colleague.example" } });
    await db.contactConsent.create({ data: { contactId: gone.id, channel: "EMAIL", topic: "OFFERS", status: "UNSUBSCRIBED", source: "PREFERENCE_CENTRE", withdrawnAt: new Date() } });
    const individualsExisted = !!(await db.company.findFirst({ where: { normalizedName: normalizeCompanyName("Individuals (mailing lists)") } }));

    const listCsv = [
      "Email,Name,Company,Designation",
      "new.one@zzmm-acme.example,New One,ZZMM Acme Pvt,IT Manager",
      "second@zzmm-acme.example,Second Person,  zzmm   ACME pvt ,Director",
      "new@zzmm-colleague.example,Colleague New,,",
      "zzmm.person@gmail.com,Gmail Person,,",
      "EXISTING@zzmm-colleague.example,,,",
      "gone@zzmm-colleague.example,,,",
      "not-an-email,Bad,,",
      "New.One@ZZMM-acme.example,Dup,,",
      "solo@zzmm-newco.example,Solo,,",
    ].join("\n");
    const listForm = (over: Record<string, string> = {}) => {
      const f = new FormData();
      f.set("file", new File([listCsv], "roundtable.csv", { type: "text/csv" }));
      f.set("name", `${TAG} Roundtable`);
      f.set("consentNote", "Signed up for updates at the ZZMM roundtable");
      f.set("confirmed", "yes");
      f.append("topics", "OFFERS");
      for (const [k, v] of Object.entries(over)) f.set(k, v);
      return f;
    };
    ok("a list without the consent confirmation is refused", (await uploadListRoute.POST(post("/api/marketing/lists/upload", listForm({ confirmed: "no" })))).status === 400);
    ok("  and without saying how they agreed", (await uploadListRoute.POST(post("/api/marketing/lists/upload", listForm({ consentNote: "yes" })))).status === 400);
    const listResponse = await uploadListRoute.POST(post("/api/marketing/lists/upload", listForm()));
    const imported = (await listResponse.json()) as { ok: boolean; data: { listId: string; rows: number; invalid: number; duplicates: number; matchedContacts: number; createdContacts: number; createdCompanies: number; consentRecorded: number; alreadyUnsubscribed: number; checked: { valid: number; risky: number } } };
    const s = imported.data;
    ok("the list is read: 7 people, 1 bad address, 1 repeat", imported.ok && s.rows === 7 && s.invalid === 1 && s.duplicates === 1, JSON.stringify(s));
    ok("  2 were already contacts — matched whatever the case — and 5 became new ones", s.matchedContacts === 2 && s.createdContacts === 5 && (await db.contact.count({ where: { email: { equals: "existing@zzmm-colleague.example", mode: "insensitive" } } })) === 1);
    ok(`  companies: one for "ZZMM Acme Pvt" (however it was typed), one from a new domain${individualsExisted ? "" : ", and the shared Individuals record"}`, s.createdCompanies === (individualsExisted ? 2 : 3), s.createdCompanies);
    const colleagueNew = await db.contact.findFirst({ where: { email: "new@zzmm-colleague.example" } });
    ok("  somebody from a colleague's domain joins the colleague's company", colleagueNew?.companyId === colleagueCo.id);
    const gmail = await db.contact.findFirst({ where: { email: "zzmm.person@gmail.com" }, include: { company: { select: { name: true } } } });
    ok("  a gmail address with no company goes to the one Individuals record", gmail?.company.name === "Individuals (mailing lists)");
    ok("  job titles mapped", (await db.contact.findFirst({ where: { email: "new.one@zzmm-acme.example" } }))?.designation === "IT_MANAGER");
    ok("consent recorded for everybody but the one who unsubscribed — who stays unsubscribed", s.consentRecorded === 6 && s.alreadyUnsubscribed === 1 && (await db.contactConsent.findFirst({ where: { contactId: gone.id, topic: "OFFERS" } }))?.status === "UNSUBSCRIBED");
    const evidence = await db.contactConsent.findFirst({ where: { contactId: existing.id, topic: "OFFERS" } });
    ok("  with the uploader's words as the evidence", evidence?.status === "SUBSCRIBED" && evidence.source === "IMPORT" && evidence.evidence?.includes("Signed up for updates at the ZZMM roundtable") === true);
    ok("every address was checked on the way in", s.checked.valid === 6 && s.checked.risky === 1, JSON.stringify(s.checked));

    // ───────────────────────────────────────────────────────────────────────────
    section("Sending it");

    const reach = await marketing.previewRecipients({ templateId: template.id, listId: s.listId });
    ok("before sending: 5 will receive it, 2 won't — and why", reach?.willReceive === 5 && reach.withheld === 2 && reach.reasons.some((r) => /free-provider/.test(r.reason)) && reach.reasons.some((r) => /stop sending|opted out/.test(r.reason)), JSON.stringify(reach?.reasons));
    as(builder);
    const draft = await marketing.sendMassMail({ name: `${TAG} Builder draft`, templateId: template.id, listId: s.listId });
    ok("somebody who may build but not send gets a draft for a colleague", draft.ok && draft.data.outcome === "DRAFT" && (await db.campaign.findUnique({ where: { id: draft.data.id } }))?.status === "DRAFT");
    as(outsider);
    ok("  and somebody who may do neither gets nothing", !(await marketing.sendMassMail({ name: `${TAG} Nope`, templateId: template.id, listId: s.listId })).ok);
    as(marketer);
    ok("nobody at all is refused", !(await marketing.sendMassMail({ name: `${TAG} Empty`, templateId: template.id })).ok);
    const done = await marketing.sendMassMail({ name: `${TAG} Diwali blast`, templateId: template.id, listId: s.listId });
    ok("the marketer sends it in one step: 5 queued, 2 held back", done.ok && done.data.outcome === "QUEUED" && done.data.queued === 5 && done.data.withheld === 2, JSON.stringify(done));
    if (!done.ok) throw new Error("cannot continue");
    const campaignId = done.data.id;

    const queued = await db.marketingMessage.findMany({ where: { campaignId, status: "QUEUED" }, include: { contact: { select: { email: true } } } });
    const toColleague = queued.find((m) => m.contact?.email === "new@zzmm-colleague.example")!;
    ok("each email is its person's: their name, their company — escaped", toColleague.body.includes("Hello Colleague at ZZMM Colleague &amp; Co &lt;Ltd&gt;") && !toColleague.body.includes("<Ltd>"), toColleague.body.match(/Hello[^<]*/)?.[0]);
    ok("  the picture at an absolute address", toColleague.body.includes(`src="${ORIGIN}/api/marketing/assets/${template.assets[0]!.id}/logo.png"`));
    ok("  the link through its own tracker, the pixel with its own token", toColleague.body.includes(`${ORIGIN}/track/${toColleague.token}?u=`) && toColleague.body.includes(`<img src="${ORIGIN}/track/${toColleague.token}"`));
    ok("  a footer with its own unsubscribe link and the postal address", toColleague.body.includes(`${ORIGIN}/preferences/${toColleague.token}`));
    ok("  a text part and a one-click unsubscribe address", !!toColleague.textBody?.includes("Hello Colleague") && toColleague.unsubscribeUrl === `${ORIGIN}/api/marketing/unsubscribe/${toColleague.token}`);
    ok("  the subject filled in", toColleague.subject === "Colleague, your Diwali offer");
    const held = await db.marketingMessage.findMany({ where: { campaignId, status: "SUPPRESSED" }, include: { contact: { select: { email: true } } } });
    ok("the two held back are on record with why", held.length === 2 && held.every((h) => !!h.suppressedReason && h.body === ""), held.map((h) => `${h.contact?.email}: ${h.suppressedReason}`).join(" | "));

    // Due now, whatever the quiet hours — and never while real mail is waiting to go.
    await db.marketingMessage.updateMany({ where: { campaignId, status: "QUEUED" }, data: { scheduledFor: new Date(Date.now() - 60_000) } });
    const othersDue = await db.marketingMessage.count({ where: { status: "QUEUED", scheduledFor: { lte: new Date() }, NOT: { campaignId } } });
    if (othersDue > 0) {
      console.log(`  (skipped the send itself — ${othersDue} real message(s) are queued and due, and this check never sends those)`);
    } else {
      const tick = await pipeline.sendQueued("zzmm-run");
      ok("the sender takes all five and hands them to the provider", tick.sent === 5 && sent.length === 5, `${tick.sent} / ${sent.length}`);
      const out = sent.find((m) => m.to === "new@zzmm-colleague.example");
      ok("  with the HTML, its own text part, and the one-click unsubscribe header's address", !!out && out.html.includes("Hello Colleague") && !!out.text?.includes("Hello Colleague") && out.listUnsubscribe === `${ORIGIN}/api/marketing/unsubscribe/${toColleague.token}`);
      await pipeline.settleCampaigns();
      ok("and the campaign, with nothing left to send, says Sent", (await db.campaign.findUnique({ where: { id: campaignId } }))?.status === "SENT");
    }

    // ───────────────────────────────────────────────────────────────────────────
    section("What they did with it");

    const token = toColleague.token;
    const open = await trackRoute.GET(new Request(`${ORIGIN}/track/${token}`), { params: Promise.resolve({ token }) });
    ok("opening it loads the pixel and records the open", open.headers.get("content-type") === "image/gif" && (await db.messageEvent.count({ where: { messageId: toColleague.id, type: "OPEN" } })) === 1);
    const linkHref = toColleague.body.match(/href="([^"]*\/track\/[^"]*)"/)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const click = await trackRoute.GET(new Request(linkHref), { params: Promise.resolve({ token }) });
    ok("clicking the link records the click and lands on the real page", click.status === 302 && click.headers.get("location") === "https://zzmm.example/offer?a=1&b=2" && (await db.messageEvent.count({ where: { messageId: toColleague.id, type: "CLICK" } })) === 1, click.headers.get("location"));
    const tampered = await trackRoute.GET(new Request(`${ORIGIN}/track/${token}?u=${encodeURIComponent("https://evil.example")}&s=00`), { params: Promise.resolve({ token }) });
    ok("  a link pointed somewhere else by hand is not followed", tampered.status !== 302);

    const oneClick = await unsubscribeRoute.POST(new Request(`${ORIGIN}/api/marketing/unsubscribe/${token}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), { params: Promise.resolve({ token }) });
    ok("the inbox's own Unsubscribe button works — no sign-in, no page", oneClick.status === 200 && (await db.contactConsent.count({ where: { contactId: colleagueNew!.id, status: "UNSUBSCRIBED" } })) >= 1);
    ok("  the address is suppressed, and the report can count it", (await db.suppression.count({ where: { scope: "EMAIL", value: "new@zzmm-colleague.example", reason: "UNSUBSCRIBED" } })) === 1 && (await db.messageEvent.count({ where: { messageId: toColleague.id, type: "UNSUBSCRIBE" } })) === 1);
    const unknown = await unsubscribeRoute.POST(new Request(`${ORIGIN}/api/marketing/unsubscribe/nobody-at-all-000`, { method: "POST" }), { params: Promise.resolve({ token: "nobody-at-all-000" }) });
    ok("  a token that is nobody's is answered the same way — a stranger learns nothing", unknown.status === 200);
    const followed = await unsubscribeRoute.GET(new Request(`${ORIGIN}/api/marketing/unsubscribe/${token}`), { params: Promise.resolve({ token }) });
    ok("  merely following the address changes nothing — it goes to the preference centre", followed.status === 303 && followed.headers.get("location")?.endsWith(`/preferences/${token}`) === true);
    const next = await marketing.previewRecipients({ templateId: template.id, listId: s.listId });
    ok("the next send to the same list leaves them out", next?.willReceive === 4, next?.willReceive);

    // ───────────────────────────────────────────────────────────────────────────
    section("The report, and a test");

    const report = await marketing.getCampaign(campaignId);
    ok("the report counts it: opened, clicked, unsubscribed, held back", report?.totals.opened === 1 && report.totals.clicked === 1 && report.totals.unsubscribed === 1 && report.totals.withheld === 2, JSON.stringify(report?.totals));
    ok("  the link they clicked, and why the two weren't sent", report?.links[0]?.url === "https://zzmm.example/offer?a=1&b=2" && report.withheldBecause.length >= 1);
    ok("  and one email as it was sent, to look at", !!report?.sample?.body.includes("Hello"));

    const before = sent.length;
    const test = await marketing.sendTestEmail({ templateId: template.id });
    const last = sent[sent.length - 1];
    ok("a test goes to the marketer's own inbox, marked as a test, with example values", test.ok && sent.length === before + 1 && last?.to === `marketer${MAIL}` && last.subject.startsWith("[Test] ") && last.html.includes("Hello Rajesh"), test.ok ? test.data.to : test.error);
    as(outsider);
    ok("  somebody without marketing access can't send one", !(await marketing.sendTestEmail({ templateId: template.id })).ok);
  } finally {
    await cleanup();
    const left =
      (await db.contact.count({ where: { email: { contains: "zzmm", mode: "insensitive" } } })) +
      (await db.marketingTemplate.count({ where: { name: { startsWith: TAG } } })) +
      (await db.marketingList.count({ where: { name: { startsWith: TAG } } })) +
      (await db.campaign.count({ where: { name: { startsWith: TAG } } })) +
      (await db.user.count({ where: { email: { endsWith: MAIL } } }));
    ok("nothing left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures ? `\n${failures} failed.` : "\nAll mass-mail checks pass.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
