/**
 * check:loopholes — the fixes from the security review of 23 Oct 2026 (docs/reports/loopholes-2026-10-23.md) that can
 * be checked without a server, a session or a database:
 *
 *   · an add-on brings its modules only where what they need is live — never the base product through itself;
 *   · CSV cells and headings starting with a tab or a carriage return are guarded like = + - @, and read back whole;
 *   · a download named in any script gets a header that can be sent, its name kept in filename*;
 *   · an HR upload is the kind of file it says it is, by its first bytes;
 *   · the visitor's address behind Cloudflare: believed from Cloudflare's addresses only;
 *   · a mail server a workspace names is reached only on a public address;
 *   · a redirect after the access check never leaves the app, a backslash included.
 *
 * Nothing is written anywhere, and nothing leaves the machine.
 */
import "dotenv/config";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (title: string) => console.log(`\n${title}`);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { entitlementsFrom } = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
  const { sanitizeCsvCell, desanitizeCsvCell } = require("../src/lib/csv") as typeof import("../src/lib/csv");
  const { contentDisposition } = require("../src/lib/content-disposition") as typeof import("../src/lib/content-disposition");
  const { checkUpload } = require("../src/lib/hr/document-upload") as typeof import("../src/lib/hr/document-upload");
  const { clientIpFrom, isCloudflare } = require("../src/lib/client-ip") as typeof import("../src/lib/client-ip");
  const { publicAddressOf, SafeFetchError } = require("../src/lib/net/safe-fetch") as typeof import("../src/lib/net/safe-fetch");
  const { safeAppPath } = require("../src/lib/app/paths") as typeof import("../src/lib/app/paths");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ─── Add-ons ───────────────────────────────────────────────────────────────────────────────────
  section("An add-on brings only what its needs allow");
  type Item = Parameters<typeof entitlementsFrom>[1][number];
  const plan = (key: string, kind: "EDITION" | "ADDON" | "BUNDLE" | "INTERNAL", modules: string[]): Item => ({
    quantity: 1,
    plan: { key, kind, allModules: false, seats: null, copilotTokens: null, customDomains: null, modules: modules.map((moduleKey) => ({ moduleKey })) },
  });
  const tenant = { country: "IN", seatOverride: null, copilotTokenOverride: null, customDomainOverride: null };
  const modulesOf = (items: Item[]) => entitlementsFrom(tenant, items, []).modules;
  const addonAlone = modulesOf([plan("zz-rc", "ADDON", ["revenue_close"])]);
  ok("Revenue & Close alone: neither it nor accounting", !addonAlone.includes("revenue_close") && !addonAlone.includes("accounting"), addonAlone);
  const withBooks = modulesOf([plan("zz-books", "EDITION", ["accounting"]), plan("zz-rc", "ADDON", ["revenue_close"])]);
  ok("with an edition holding accounting: both", withBooks.includes("revenue_close") && withBooks.includes("accounting"), withBooks);
  const onPurpose = modulesOf([plan("zz-rc-full", "ADDON", ["revenue_close", "accounting"])]);
  ok("an add-on that lists accounting itself: brought on purpose", onPurpose.includes("revenue_close") && onPurpose.includes("accounting"), onPurpose);
  const bundleAlone = modulesOf([plan("zz-payroll-bundle", "BUNDLE", ["payroll"])]);
  ok("a bundle of payroll without HR: no payroll, no HR", !bundleAlone.includes("payroll") && !bundleAlone.includes("hr"), bundleAlone);
  const internal = modulesOf([plan("zz-internal", "INTERNAL", ["payroll"])]);
  ok("an internal plan brings what it needs, as an edition does", internal.includes("payroll") && internal.includes("hr"), internal);

  // ─── CSV ───────────────────────────────────────────────────────────────────────────────────────
  section("CSV cells and headings");
  const tab = String.fromCharCode(9);
  const cr = String.fromCharCode(13);
  ok("a tab first is guarded", sanitizeCsvCell(`${tab}=1+1`) === `'${tab}=1+1`);
  ok("a carriage return first is guarded", sanitizeCsvCell(`${cr}cmd`) === `'${cr}cmd`);
  ok("  and both read back whole", desanitizeCsvCell(sanitizeCsvCell(`${tab}x`)) === `${tab}x` && desanitizeCsvCell(sanitizeCsvCell(`${cr}x`)) === `${cr}x`);
  ok("the four kept as they were", ["=", "+", "-", "@"].every((c) => sanitizeCsvCell(`${c}1`) === `'${c}1`));
  ok("plain text untouched", sanitizeCsvCell("Acme Traders") === "Acme Traders" && desanitizeCsvCell("'quoted") === "'quoted");

  // ─── Download names ────────────────────────────────────────────────────────────────────────────
  section("A file's name in its download header");
  const names = ["Report – Q3.pdf", "रिपोर्ट.pdf", 'a"b.pdf', `a${String.fromCharCode(92)}b.pdf`, `a${cr}${String.fromCharCode(10)}Set-Cookie: x.pdf`, ""];
  for (const name of names) {
    let sent = true;
    try {
      new Headers({ "content-disposition": contentDisposition("attachment", name) });
    } catch {
      sent = false;
    }
    ok(`  ${JSON.stringify(name)}: a header that can be sent`, sent);
  }
  const header = contentDisposition("inline", "Report – Q3.pdf");
  ok("  the plain name folded to ASCII, the real one in filename*", header.startsWith('inline; filename="Report _ Q3.pdf"') && decodeURIComponent(header.split("UTF-8''")[1]!) === "Report – Q3.pdf", header);

  // ─── HR uploads ────────────────────────────────────────────────────────────────────────────────
  section("An HR upload is what it says it is");
  const dataUrl = (mime: string, bytes: number[]) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
  const PDF = [...Buffer.from("%PDF-1.7\n")];
  const DOCX = [0x50, 0x4b, 0x03, 0x04, 20, 0];
  const WEBP = [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBPVP8 ")];
  const upload = (mimeType: string, bytes: number[]) => checkUpload({ name: "Doc", mimeType, fileDataUrl: dataUrl(mimeType, bytes) });
  ok("a real PNG", upload("image/png", PNG).ok);
  ok("a real PDF", upload("application/pdf", PDF).ok);
  ok("a real .docx", upload("application/vnd.openxmlformats-officedocument.wordprocessingml.document", DOCX).ok);
  ok("a real WebP", upload("image/webp", WEBP).ok);
  ok("text called a PNG: refused", !upload("image/png", [...Buffer.from("hello world")]).ok);
  ok("an HTML page called a PDF: refused", !upload("application/pdf", [...Buffer.from("<html><script>")]).ok);
  ok("a RIFF that isn't WebP: refused", !upload("image/webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("AVI LIST")]).ok);

  // ─── Behind Cloudflare ─────────────────────────────────────────────────────────────────────────
  section("The visitor's address behind Cloudflare");
  const env = process.env as Record<string, string | undefined>;
  const before = { proxy: env.TRUST_PROXY, hops: env.TRUST_PROXY_HOPS, cf: env.TRUST_PROXY_CLOUDFLARE };
  const h = (o: Record<string, string>) => new Headers(o);
  try {
    env.TRUST_PROXY = "1";
    env.TRUST_PROXY_HOPS = "1";
    env.TRUST_PROXY_CLOUDFLARE = "";
    ok("without the setting: the edge, as before", clientIpFrom(h({ "x-forwarded-for": "49.36.1.2, 172.70.1.1", "cf-connecting-ip": "49.36.1.2" })) === "172.70.1.1");
    env.TRUST_PROXY_CLOUDFLARE = "1";
    ok("through Cloudflare: the visitor", clientIpFrom(h({ "x-forwarded-for": "49.36.1.2, 172.70.1.1", "cf-connecting-ip": "49.36.1.2" })) === "49.36.1.2");
    ok("straight to the server with the header made up: its own address", clientIpFrom(h({ "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "10.0.0.1" })) === "203.0.113.9");
    ok("Cloudflare's IPv6 edge counts as Cloudflare", isCloudflare("2606:4700:10::6816:5602") && !isCloudflare("8.8.8.8"));
    env.TRUST_PROXY = "";
    ok("without TRUST_PROXY: nothing believed", clientIpFrom(h({ "x-forwarded-for": "162.158.5.5", "cf-connecting-ip": "1.2.3.4" })) === null);
  } finally {
    env.TRUST_PROXY = before.proxy;
    env.TRUST_PROXY_HOPS = before.hops;
    env.TRUST_PROXY_CLOUDFLARE = before.cf;
  }

  // ─── A workspace's mail server ─────────────────────────────────────────────────────────────────
  section("A mail server a workspace names: public addresses only");
  const resolve = (answers: Record<string, string[]>) => async (host: string) => answers[host] ?? [];
  const refused = async (host: string, answers: Record<string, string[]> = {}) =>
    publicAddressOf(host, { resolve: resolve(answers) }).then(
      () => false,
      (err: unknown) => err instanceof SafeFetchError,
    );
  ok("127.0.0.1: refused", await refused("127.0.0.1"));
  ok("10.0.0.5: refused", await refused("10.0.0.5"));
  ok("the Azure host address: refused", await refused("168.63.129.16"));
  ok("a name pointing at the database's private address: refused", await refused("db.example", { "db.example": ["172.18.0.3"] }));
  ok("a name with one public and one private answer: refused", await refused("mixed.example", { "mixed.example": ["52.1.2.3", "10.1.1.1"] }));
  ok("a name with no answer: refused", await refused("nothing.example"));
  ok("a public mail server: its address, IPv4 first", (await publicAddressOf("smtp.example", { resolve: resolve({ "smtp.example": ["2606:4700::1", "52.1.2.3"] }) })) === "52.1.2.3");

  // ─── Redirects ─────────────────────────────────────────────────────────────────────────────────
  section("Somewhere inside the app, and nowhere else");
  ok("a path in the app", safeAppPath("/leads?view=board") === "/leads?view=board");
  ok("//host: refused", safeAppPath("//evil.example") === null);
  ok("a backslash after the slash: refused", safeAppPath(`/${String.fromCharCode(92)}evil.example`) === null);
  ok("an absolute address: refused", safeAppPath("https://evil.example") === null);

  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll loophole checks passed.");
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
