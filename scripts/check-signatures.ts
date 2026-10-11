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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EMPTY_DETAILS,
  GMAIL_LIMIT,
  SIGNATURE_TEMPLATES,
  escapeHtml,
  imageNote,
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
