/**
 * check:signatures — the free email signature generator (src/lib/signatures/render.ts, its block
 * src/components/site/blocks/signature-generator.tsx, and its page in scripts/site-content/tools.ts).
 *
 * A signature travels inside every email somebody sends, so the rules that matter are safety and
 * portability: everything typed is escaped, a link is only http(s), mailto: or tel:, an image only an
 * address or a png/jpeg/gif/webp picture, the HTML is tables and inline styles a mail program keeps,
 * and Gmail's 10,000-character limit is counted. Then: every layout, the plain-text twin, the
 * "Made with" credit, the CMS's validator, and the block rendered as the website serves it.
 * Nothing is written anywhere.
 *
 *   npm run check:signatures
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_DETAILS,
  GMAIL_LIMIT,
  SIGNATURE_TEMPLATES,
  escapeHtml,
  imageNote,
  linkNote,
  renderSignature,
  safeImage,
  safeUrl,
  signatureText,
  type SignatureDetails,
  type SignatureStyle,
} from "../src/lib/signatures/render";
import { checkPageDocument } from "../src/lib/cms/validate";
import { DEFAULT_SITE_SETTINGS } from "../src/components/site/defaults";
import { SignatureGeneratorBlock } from "../src/components/site/blocks/signature-generator";
import type { SiteRenderContext } from "../src/components/site/blocks/types";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const MADE = { href: "https://deskzo.com/email-signature-generator", name: "Deskzo" };
const style = (template: SignatureStyle["template"], color = "#1d4ed8"): SignatureStyle => ({ template, color, font: "arial" });

const full: SignatureDetails = {
  ...EMPTY_DETAILS,
  name: "Priya Sharma",
  jobTitle: "Sales manager",
  department: "Enterprise",
  company: "Acme Traders",
  phone: "+91 22 4000 1000",
  mobile: "+91 98765 43210",
  email: "Priya@Acme.test",
  website: "acme.test",
  address: "1 MG Road, Mumbai",
  photo: "https://acme.test/priya.jpg",
  logo: "https://acme.test/logo.png",
  social: { linkedin: "linkedin.com/in/priya", x: "", facebook: "", instagram: "", youtube: "youtube.com/@acme" },
  signOff: "Best regards,",
  ctaLabel: "Book a meeting",
  ctaUrl: "https://cal.acme.test/priya",
  disclaimer: "This email is confidential.",
};

async function main() {
  section("Escaping and safe links");
  ok("text is escaped", escapeHtml(`<b>"Tom" & 'Jerry'</b>`) === "&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
  const hostile = renderSignature(
    {
      ...full,
      name: `<script>alert(1)</script>`,
      company: `"><img src=x onerror=alert(1)>`,
      website: "javascript:alert(1)",
      ctaUrl: "javascript:alert(1)",
      social: { ...full.social, linkedin: "data:text/html,hi" },
      photo: "javascript:alert(1)",
      logo: "data:image/svg+xml;base64,PHN2Zz4=",
    },
    style("classic"),
    MADE,
  );
  ok("a name with a script tag is shown as text, never run", !/<script/i.test(hostile) && hostile.includes("&lt;script&gt;"));
  ok("a company trying to break out of an attribute stays text", !/<img src=x/i.test(hostile) && hostile.includes("&quot;&gt;&lt;img"));
  ok("no javascript: or data:text link survives anywhere", !/javascript:/i.test(hostile) && !/data:text/i.test(hostile));
  ok("an SVG picture is refused (it can carry script); png, jpeg, gif and webp are taken", safeImage("data:image/svg+xml;base64,PHN2Zz4=") === null && safeImage("data:image/png;base64,iVBORw0KGgo=") !== null);
  ok("an address with a password in it is refused", safeUrl("https://user:pass@acme.test") === null);
  ok("an address without https:// gets it", safeUrl("acme.test/about") === "https://acme.test/about");
  ok("a picked picture is warned about for Gmail; a bad address is named", /Gmail/.test(imageNote("data:image/png;base64,iVBORw0KGgo=") ?? "") && /https/.test(imageNote("not a url") ?? ""));

  section("What a signature is made of");
  const html = renderSignature(full, style("classic"), MADE);
  ok("tables and inline styles only — no stylesheet, no class, no script", html.includes("<table") && !/<style|class=|<script/i.test(html));
  ok("the phone is a tel: link, the email a lower-cased mailto:", html.includes('href="tel:+912240001000"') && html.includes('href="mailto:priya@acme.test"'));
  ok("social profiles are badges with their addresses, made https", html.includes('href="https://linkedin.com/in/priya"') && html.includes(">in</a>") && html.includes(">yt</a>"));
  ok("the button is a coloured table cell Outlook draws", /<td bgcolor="#1d4ed8"[^>]*><a href="https:\/\/cal\.acme\.test\/priya"/.test(html));
  ok("the photo is round, at the side, with the colour's bar beside it", html.includes('src="https://acme.test/priya.jpg"') && html.includes("border-radius:50%") && html.includes("border-left:2px solid #1d4ed8"));
  ok("the credit links back to the generator", html.includes('Made with <a href="https://deskzo.com/email-signature-generator"') && html.includes(">Deskzo</a>"));
  ok("without a credit (the paid product), there is none", !renderSignature(full, style("classic"), null).includes("Made with"));
  ok("a full signature is well inside Gmail's limit", html.length < GMAIL_LIMIT, html.length);
  const heavy = renderSignature({ ...full, photo: `data:image/jpeg;base64,${"A".repeat(20_000)}` }, style("classic"), MADE);
  ok("a picked picture makes it too long for Gmail — which the page counts", heavy.length > GMAIL_LIMIT);
  ok("on a light colour the badge text is dark; on a dark one, white", renderSignature(full, style("classic", "#facc15"), MADE).includes("color:#111111;font-family:Arial") && html.includes("color:#ffffff;font-family:Arial"));
  ok("a colour that isn't one falls back to the default", renderSignature(full, style("classic", "red;background:url(x)"), MADE).includes("#1d4ed8") && !renderSignature(full, style("classic", "red;background:url(x)"), MADE).includes("url(x)"));

  section("Every layout");
  for (const t of SIGNATURE_TEMPLATES) {
    const out = renderSignature(full, style(t.key), MADE);
    ok(`${t.label}: the name, the company, the contacts and the credit`, out.includes("Priya Sharma") && out.includes("Acme Traders") && out.includes("mailto:priya@acme.test") && out.includes("Made with"));
  }
  ok("an empty form still draws something to look at", renderSignature(EMPTY_DETAILS, style("classic"), MADE).includes("Your name"));
  const text = signatureText(full, MADE);
  ok("the plain-text twin has every line, in order", text.startsWith("Best regards,\nPriya Sharma\nSales manager, Enterprise\nAcme Traders\nT +91 22 4000 1000  M +91 98765 43210\npriya@acme.test"), text.split("\n").slice(0, 6).join(" | "));
  ok("...and the credit with its address", text.endsWith("Made with Deskzo: https://deskzo.com/email-signature-generator"));

  section("https only");
  ok("an http:// link is refused — everywhere a signature links to", safeUrl("http://acme.test") === null && safeUrl("HTTP://acme.test/x") === null && safeUrl("https://acme.test") === "https://acme.test/");
  ok("...and says what to change", /change http:\/\/ to https:\/\//.test(linkNote("http://acme.test") ?? "") && linkNote("https://acme.test") === null && linkNote("") === null && linkNote("not a site") === "That isn't a web address.");
  ok("an http:// picture is refused too, and says so", safeImage("http://acme.test/logo.png") === null && /https:\/\//.test(imageNote("http://acme.test/logo.png") ?? ""));
  ok("the only exception: an address on this computer while developing", safeUrl("http://zz.localhost:3000/x") !== null && safeUrl("http://intranet.acme/x") === null);
  const plainHttp = renderSignature({ ...full, website: "http://acme.test", logo: "http://acme.test/logo.png", ctaUrl: "http://acme.test/book", social: { ...full.social, linkedin: "http://linkedin.com/in/priya" } }, style("stacked"), MADE);
  ok("so a signature given http:// addresses carries none of them", !/http:\/\/(?!localhost)/.test(plainHttp.replace(/https:\/\//g, "")) && !plainHttp.includes("acme.test/logo.png"));

  section("The logo's link");
  const logoLinked = renderSignature({ ...full, photo: "" }, style("classic"), MADE);
  ok("the logo links to the website when it has no link of its own", logoLinked.includes('<a href="https://acme.test/" style="text-decoration:none;"><img src="https://acme.test/logo.png"'));
  const ownLink = renderSignature({ ...full, logoLink: "acme.test/about" }, style("modern"), MADE);
  ok("...or to its own link, made https", ownLink.includes('<a href="https://acme.test/about" style="text-decoration:none;"><img src="https://acme.test/logo.png"'));
  ok("...and never to an http:// one", !renderSignature({ ...full, website: "", logoLink: "http://acme.test" }, style("modern"), MADE).includes('<a href="http://acme.test'));

  section("A banner under the signature");
  const BANNER = { image: "https://acme.test/fair.png", link: "acme.test/fair", alt: `Meet us at the fair <hall 4>`, width: 520 };
  const withBanner = renderSignature({ ...full, banner: BANNER }, style("classic"), MADE);
  const bannerAt = withBanner.indexOf('src="https://acme.test/fair.png"');
  ok("it is drawn under the signature — after the details, before the disclaimer and the credit", bannerAt > withBanner.indexOf("Priya Sharma") && bannerAt > withBanner.indexOf("Book a meeting") && bannerAt < withBanner.indexOf("This email is confidential.") && bannerAt < withBanner.indexOf("Made with"));
  ok("...linked to its https address, at its width, its words escaped for where pictures are blocked", withBanner.includes('<a href="https://acme.test/fair" style="text-decoration:none;"><img src="https://acme.test/fair.png" alt="Meet us at the fair &lt;hall 4&gt;" width="520"'));
  ok("a width outside 120–600 is brought inside it", renderSignature({ ...full, banner: { ...BANNER, width: 2000 } }, style("classic"), MADE).includes('width="600"') && renderSignature({ ...full, banner: { ...BANNER, width: 10 } }, style("classic"), MADE).includes('width="120"'));
  ok("an http:// picture or a picture inside the signature is no banner at all", !renderSignature({ ...full, banner: { ...BANNER, image: "http://acme.test/fair.png" } }, style("classic"), MADE).includes("fair.png") && !renderSignature({ ...full, banner: { ...BANNER, image: "data:image/png;base64,iVBORw0KGgo=" } }, style("classic"), MADE).includes("data:image"));
  ok("an http:// link leaves the picture unlinked", !renderSignature({ ...full, banner: { ...BANNER, link: "http://acme.test/fair" } }, style("classic"), MADE).includes('href="http://acme.test/fair"'));
  ok("the plain-text twin carries its words and link", signatureText({ ...full, banner: BANNER }, null).includes("Meet us at the fair <hall 4>: https://acme.test/fair"));
  ok("with a banner, a full signature is still well inside Gmail's limit", withBanner.length < GMAIL_LIMIT, withBanner.length);

  section("Premium layouts — the paid product's, not the free generator's");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const premium = require("../src/lib/signatures/premium") as typeof import("../src/lib/signatures/premium");
  const generatorModule = require("../src/components/site/signature-generator") as typeof import("../src/components/site/signature-generator");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const generatorSource = readFileSync(path.join(__dirname, "../src/components/site/signature-generator.tsx"), "utf8");
  ok("the free generator offers the four free layouts and never imports the premium ones", SIGNATURE_TEMPLATES.length === 4 && !/(from|import\()\s*["'][^"']*signatures\/premium/.test(generatorSource));
  ok("...but names them, in step with the paid product's list", JSON.stringify(generatorModule.PREMIUM_LAYOUT_NAMES) === JSON.stringify(premium.PREMIUM_TEMPLATES.map((t) => t.label)));
  ok("the free renderer draws a premium name as its own Classic — it can't draw them", renderSignature(full, style("executive" as never), MADE) === renderSignature(full, style("classic"), MADE));
  ok("six premium layouts, ten in all, and the stored names map onto every one", premium.PREMIUM_TEMPLATES.length === 6 && premium.ALL_SIGNATURE_LAYOUTS.length === 10 && Object.values(premium.STORED_LAYOUTS).every((k) => premium.ALL_SIGNATURE_LAYOUTS.some((l) => l.key === k)));
  const drawn = new Set<string>();
  for (const t of premium.PREMIUM_TEMPLATES) {
    const out = premium.renderAnySignature({ ...full, banner: BANNER }, { template: t.key, color: "#0f766e", font: "georgia" }, null);
    drawn.add(out);
    ok(
      `${t.label}: name, company, contacts, linked logo and banner — tables and inline styles only`,
      out.includes("Priya Sharma") && out.includes("Acme Traders") && out.includes("mailto:priya@acme.test") && out.includes('<a href="https://acme.test/" style="text-decoration:none;"><img src="https://acme.test/logo.png"') && out.includes("fair.png") && !/<style|class=|<script/i.test(out) && out.length < GMAIL_LIMIT,
      out.length,
    );
  }
  ok("...each one its own design", drawn.size === premium.PREMIUM_TEMPLATES.length);
  ok("...and none carries the free generator's credit unless asked", ![...drawn].some((h) => h.includes("Made with")));
  ok("Corporate without a logo shows the company's initials on its panel", premium.renderAnySignature({ ...full, logo: "" }, { template: "corporate", color: "#0f766e", font: "arial" }, null).includes(">AT</div>"));
  ok("Spotlight keeps the name dark on a light colour, so it reads", premium.renderAnySignature(full, { template: "spotlight", color: "#facc15", font: "arial" }, null).includes("font-size:20px;font-weight:bold;color:#111111;"));
  ok("a premium layout given hostile text escapes it like every other", !/<script/i.test(premium.renderAnySignature({ ...full, name: "<script>alert(1)</script>" }, { template: "bold", color: "#0f766e", font: "arial" }, null)));
  ok("tint mixes the colour towards white", premium.tint("#000000", 0.5) === "#808080" && premium.tint("#1d4ed8", 1) === "#ffffff");

  section("Sample banners");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const samples = require("../src/lib/signatures/samples") as typeof import("../src/lib/signatures/samples");
  /* eslint-enable @typescript-eslint/no-require-imports */
  for (const s of samples.SIGNATURE_BANNER_SAMPLES) {
    const file = path.join(__dirname, "..", "public", samples.sampleBannerPath(s.key));
    let bytes: Buffer | null = null;
    try {
      bytes = readFileSync(file);
    } catch {
      bytes = null;
    }
    const meta = bytes ? await sharp(bytes, { animated: true }).metadata() : null;
    ok(
      `${s.name}: an animated GIF, ${samples.SAMPLE_BANNER_SIZE.width} × ${samples.SAMPLE_BANNER_SIZE.height}, small enough to travel, its words said for blocked pictures`,
      !!bytes &&
        bytes.subarray(0, 6).toString("ascii") === "GIF89a" &&
        meta?.format === "gif" &&
        (meta.pages ?? 1) > 1 &&
        meta.width === samples.SAMPLE_BANNER_SIZE.width &&
        meta.pageHeight === samples.SAMPLE_BANNER_SIZE.height &&
        bytes.length < 120 * 1024 &&
        s.alt.length >= 10 &&
        s.alt.length <= 150 &&
        !!safeUrl(s.link),
      bytes ? `${meta?.pages} frames, ${Math.round(bytes.length / 1024)} KB` : "missing — run npm run signatures:banners",
    );
  }
  ok("each sample has its own name", new Set(samples.SIGNATURE_BANNER_SAMPLES.map((s) => s.key)).size === samples.SIGNATURE_BANNER_SAMPLES.length);

  section("The page and the block");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const tools = require("./site-content/tools") as typeof import("./site-content/tools");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const page = tools.section.pages?.[0];
  ok("the page is /email-signature-generator, and the CMS's validator takes it", page?.slug === "email-signature-generator" && !!page && checkPageDocument(page.document, "publish").ok);
  const block = page?.document.blocks.find((b) => b.type === "signatureGenerator");
  ok("...with the generator on it", !!block);
  const broken = { ...page!.document, blocks: [{ id: "x", type: "signatureGenerator", props: { upsellBody: "no heading" } }] };
  ok("a generator block without its team heading is refused", !checkPageDocument(broken, "publish").ok);

  const ctx: SiteRenderContext = { settings: { ...DEFAULT_SITE_SETTINGS, siteName: "Deskzo", displayDomain: "deskzo.com" }, signupOpen: true, trialDays: 14, searchParams: {}, workspaceSuffix: ".deskzo.com" };
  const markup = block && block.type === "signatureGenerator" ? renderToStaticMarkup(createElement(SignatureGeneratorBlock, { props: block.props, ctx })) : "";
  ok("rendered: the form, the preview, the copy button and the steps for each mail program", markup.includes("Copy signature") && markup.includes("Your name") && markup.includes("Apple Mail") && markup.includes("Outlook for Windows (classic)"), markup.length);
  ok("...the credit names the site and links to it", markup.includes("Made with <a href=&quot;https://deskzo.com&quot;") || markup.includes('Made with <a href="https://deskzo.com"'));
  ok("...and the team upsell, with its button to Deskzo Signatures", markup.includes("Signatures for your whole team") && markup.includes("href=\"/signatures\""));
  ok("...and says nothing typed leaves the browser", markup.includes("Nothing you type here is sent to us"));

  console.log(failures ? `\n${failures} failed.\n` : "\nAll passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
