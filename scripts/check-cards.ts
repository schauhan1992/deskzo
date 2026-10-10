/**
 * Deskzo Cards (docs/digital-cards-and-signatures.md §3) — the rules about what a card shows, and the
 * public page's one write, through the real code.
 *
 *   · **The template decides.** A locked field can't be hidden or overridden; a field switched off
 *     never shows; a person's own values are cut down to what the template offers.
 *   · **Nothing personal by default.** A card shows the work phone and work email from the record,
 *     never the HR record's personal contacts.
 *   · **A link is a link only when it really is one.** "javascript:" typed as a website is text.
 *   · **A card speaks for somebody only while they're here.** Off by hand, with the account, and the
 *     day after the last working day — read from the exit date, no job needed.
 *   · **Sharing back is bounded.** A honeypot, a minimum fill time, the same person once a day, a limit
 *     per card; a lead only with a company, owned by the cardholder; a reseller's customer gets none;
 *     a switched-off card takes nothing; the answer never says which happened.
 *   · **Registered everywhere it must be.** Module, permissions, section, action map, public path.
 *
 * Against the development database, through a direct client (as check:lead-capture does), with
 * ZZPROBE_CARDS fixtures removed in a finally.
 *
 *   npm run check:cards
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
let moduleOn = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/db") return { db };
  if (request === "@/lib/audit") return { recordAudit: async () => {} };
  if (request === "@/lib/modules-access") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, moduleAvailableForTenant: async () => moduleOn };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const tpl = require("../src/lib/cards/template") as typeof import("../src/lib/cards/template");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const server = require("../src/lib/cards/server") as typeof import("../src/lib/cards/server");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pub = require("../src/actions/cards-public") as typeof import("../src/actions/cards-public");

const TAG = "ZZPROBE_CARDS";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { startsWith: TAG.toLowerCase() } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  const companies = await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const companyIds = companies.map((c) => c.id);
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.cardContact.deleteMany({ where: { card: { userId: { in: userIds } } } });
  await db.lead.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.contact.deleteMany({ where: { companyId: { in: companyIds } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.digitalCard.deleteMany({ where: { userId: { in: userIds } } });
  await db.cardTemplate.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

const PERSON = { name: "Priya Sharma", title: "Sales manager", workPhone: "+91 98765 43210", email: "priya@example.com", hasPhoto: true, branchAddress: "1 MG Road, Pune" };

function pure() {
  section("The template decides what a card shows");
  const fields = tpl.defaultTemplateFields();
  const card = tpl.resolveCard(fields, tpl.readCardValues({}), PERSON);
  ok("a new template shows title, work phone, email and photo", card.title === "Sales manager" && card.showPhoto && card.lines.some((l) => l.key === "workPhone") && card.lines.some((l) => l.key === "email"));
  ok("  and not the branch address, which starts switched off", !card.lines.some((l) => l.key === "branchAddress"));

  const hidePhone = tpl.readCardValues({ hidden: ["workPhone"] });
  ok("an open record field can be hidden by its person", !tpl.resolveCard(fields, hidePhone, PERSON).lines.some((l) => l.key === "workPhone"));
  const lockedPhone = fields.map((f) => (f.key === "workPhone" ? { ...f, locked: true } : f));
  ok("  a locked one can't", tpl.resolveCard(lockedPhone, hidePhone, PERSON).lines.some((l) => l.key === "workPhone"));

  const withSite = fields.map((f) => (f.key === "website" ? { ...f, value: "www.acme.in" } : f));
  const ownSite = tpl.readCardValues({ own: { website: "www.priya.dev" } });
  ok("a locked shared field shows the company's value, whatever the person typed", tpl.resolveCard(withSite, ownSite, PERSON).lines.find((l) => l.key === "website")?.value === "www.acme.in");
  const openSite = withSite.map((f) => (f.key === "website" ? { ...f, locked: false } : f));
  ok("  an open one shows theirs", tpl.resolveCard(openSite, ownSite, PERSON).lines.find((l) => l.key === "website")?.value === "www.priya.dev");

  const lockedLinkedIn = fields.map((f) => (f.key === "linkedin" ? { ...f, locked: true } : f));
  const li = tpl.readCardValues({ own: { linkedin: "linkedin.com/in/priya" } });
  ok("an own field shows when filled in", tpl.resolveCard(fields, li, PERSON).lines.some((l) => l.key === "linkedin"));
  ok("  and not when the template locks it away", !tpl.resolveCard(lockedLinkedIn, li, PERSON).lines.some((l) => l.key === "linkedin"));
  const off = fields.map((f) => (f.key === "email" ? { ...f, on: false } : f));
  ok("a field switched off never shows", !tpl.resolveCard(off, tpl.readCardValues({}), PERSON).lines.some((l) => l.key === "email"));

  const permitted = tpl.permittedValues(lockedPhone, tpl.readCardValues({ own: { linkedin: "x.com/p", website: "evil.example", title: "CEO" }, hidden: ["workPhone", "email"] }));
  ok("a person's values are cut down to what the template offers", permitted.own.linkedin === "x.com/p" && permitted.own.website === undefined && !("title" in permitted.own) && permitted.hidden.join() === "email", JSON.stringify(permitted));
  ok("the stored field list is read defensively", tpl.readTemplateFields([{ key: "nonsense", on: true }, { key: "email", on: true, locked: false }, "x"]).length === tpl.CARD_FIELDS.length);

  section("Nothing personal by default");
  const defs = tpl.CARD_FIELDS.filter((f) => f.kind === "record").map((f) => f.key).sort().join();
  ok("record fields are only work ones", defs === ["branchAddress", "email", "photo", "title", "workPhone"].sort().join(), defs);
  ok("a personal mobile is the person's own field, off on a new template", tpl.CARD_FIELDS.find((f) => f.key === "mobile")?.kind === "own" && tpl.defaultTemplateFields().find((f) => f.key === "mobile")?.on === false);

  section("A link only when it really is one");
  ok("javascript: typed as a website is text", tpl.hrefFor("url", "javascript:alert(1)") === null);
  ok("  a bare domain becomes https", tpl.hrefFor("url", "acme.in") === "https://acme.in/");
  ok("  a phone becomes tel: with its digits", tpl.hrefFor("tel", "+91 98765 43210") === "tel:+919876543210");
  ok("  WhatsApp opens wa.me", tpl.hrefFor("whatsapp", "+91 98765-43210") === "https://wa.me/919876543210");
  ok("  a broken email is text", tpl.hrefFor("mailto", "priya at acme") === null);

  section("Addresses and the vCard");
  ok("a name becomes its address", tpl.slugBase("Priya Sharma") === "priya-sharma" && tpl.slugBase("José Núñez") === "jose-nunez");
  ok("  a name with no Latin letters still gets one", tpl.SLUG_PATTERN.test(tpl.slugBase("प्रिया")), tpl.slugBase("प्रिया"));
  ok("  the next free one is numbered", tpl.freeSlug("Priya Sharma", new Set(["priya-sharma", "priya-sharma-2"])) === "priya-sharma-3");
  const vcf = tpl.buildVCard({ ...card, name: "Priya; Sharma", about: "Line one\nline two" }, "Acme, Inc.", "https://acme.deskzo.com/c/priya", null);
  ok("the vCard escapes what vCard reserves", vcf.includes("ORG:Acme\\, Inc.") && vcf.includes("NOTE:Line one\\nline two") && vcf.includes("FN:Priya\\; Sharma"));
  ok("  ends lines CRLF and folds long ones", vcf.split("\r\n").every((l) => l.length <= 75) && vcf.startsWith("BEGIN:VCARD\r\nVERSION:3.0"));
  const injected = tpl.buildVCard({ ...card, about: "hi\rEND:VCARD\r\nBEGIN:VCARD" }, null, "https://x.example/c/p", null);
  ok("  a typed line break never starts a vCard line of its own", injected.split("\r\n").filter((l) => l === "END:VCARD").length === 1 && !/\r(?!\n)/.test(injected));
  const wide = tpl.buildVCard({ ...card, about: "प्रिया ".repeat(30) + "🙂".repeat(10) }, null, "https://x.example/c/p", null);
  ok("  folds at 75 octets without splitting a character", wide.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75) && !wide.includes("\uFFFD") && wide.replace(/\r\n /g, "").includes("🙂".repeat(10)));
  ok("  and a file name no header chokes on", tpl.vcardFileName('Priya "P" Sharma\r\n') === "Priya P Sharma.vcf");

  section("A card speaks for somebody only while they're here");
  const today = "2026-10-10";
  const live = { active: true, switchedOffWhy: null };
  const here = { active: true, employeeProfile: null };
  ok("a live card for somebody here is live", server.cardOffReason(live, here, today) === null);
  ok("  through their last working day", server.cardOffReason(live, { active: true, employeeProfile: { exitedOn: new Date("2026-10-10T00:00:00Z") } }, today) === null);
  ok("  and dark the day after, with no job run", server.cardOffReason(live, { active: true, employeeProfile: { exitedOn: new Date("2026-10-09T00:00:00Z") } }, today) === "exit");
  ok("  dark with their account — without saying they left", server.cardOffReason(live, { active: false, employeeProfile: null }, today) === "account");
  ok("  an exit switched off on the day, with the login off too, still reads as an exit", server.cardOffReason({ active: false, switchedOffWhy: "exit" }, { active: false, employeeProfile: { exitedOn: new Date("2026-10-10T00:00:00Z") } }, today) === "exit");
  ok("  and off by hand is just off", server.cardOffReason({ active: false, switchedOffWhy: "manual" }, here, today) === "manual");
  ok("issuing and the exit hook read 'left' the same way", server.hasLeft(new Date("2026-10-09T00:00:00Z"), today) && !server.hasLeft(new Date("2026-10-10T00:00:00Z"), today) && !server.hasLeft(null, today));
  const page = readFileSync(join(__dirname, "..", "src", "app", "(public)", "c", "[slug]", "page.tsx"), "utf8");
  ok("the public page names a departure only for a recorded exit", /offReason === "exit" \?/.test(page));

  section("Registered everywhere it must be");
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");
  ok("the module is in the registry", /key: "cards",/.test(read("src/lib/modules.ts")));
  ok("  its permissions and section are declared", ["cards.use", "cards.manage", "cards.viewLeads", "section.cards"].every((k) => read("src/lib/permissions.ts").includes(`key: "${k}"`)));
  ok("  nobody holds a card by default", /key: "cards\.use",[\s\S]{0,400}?defaultRoles: \[\]/.test(read("src/lib/permissions.ts")));
  ok("  its actions are mapped, the public ones as public", /"cards\.ts": \["cards"\]/.test(read("src/lib/module-actions.ts")) && /"cards-public\.ts": "public"/.test(read("src/lib/module-actions.ts")));
  ok("  and /c is a public path", /PUBLIC_PREFIXES = \[[^\]]*"\/c"/.test(read("src/proxy.ts")));
  ok("the page is noindex and no-referrer", /index: false/.test(read("src/app/(public)/c/[slug]/page.tsx")) && /no-referrer/.test(read("src/app/(public)/c/[slug]/page.tsx")));
}

async function withDb() {
  section("Issuing, and sharing back through the real action");
  await cleanup();
  const holder = await db.user.create({ data: { name: `${TAG} Holder`, email: `${TAG.toLowerCase()}-holder@example.com`, role: "SALES", phone: "+91 90000 00001", passwordHash: "!" } });
  const leaver = await db.user.create({ data: { name: `${TAG} Leaver`, email: `${TAG.toLowerCase()}-leaver@example.com`, role: "SALES", passwordHash: "!" } });
  await db.employeeProfile.create({ data: { userId: leaver.id, designation: "Ex", exitedOn: new Date("2020-01-01") } });
  const template = await db.cardTemplate.create({ data: { name: `${TAG} template`, fields: tpl.defaultTemplateFields() as never, questions: ["What are you after?"] as never } });

  const first = await server.issueCardsTo([holder.id, leaver.id], template.id, holder.id);
  ok("issuing gives a card to somebody here", first.issued.includes(holder.id));
  ok("  and skips somebody who has left", first.skipped.some((s) => s.id === leaver.id), JSON.stringify(first.skipped));
  const card = await db.digitalCard.findUniqueOrThrow({ where: { userId: holder.id } });
  ok("  at an address from their name", card.slug.startsWith("zzprobe-cards-holder"), card.slug);
  const again = await server.issueCardsTo([holder.id], template.id, holder.id);
  ok("issuing again keeps the address", again.issued.length === 0 && (await db.digitalCard.findUniqueOrThrow({ where: { userId: holder.id } })).slug === card.slug);

  const base = { name: "Asha Rao", email: "asha@zzprobe.example", elapsedMs: 5000 };
  const bot = await pub.shareBack(card.slug, { ...base, website: "http://spam" });
  ok("a filled honeypot is thanked and kept nowhere", bot.ok && (await db.cardContact.count({ where: { cardId: card.id } })) === 0);
  const fast = await pub.shareBack(card.slug, { ...base, elapsedMs: 300 });
  ok("  so is a form filled in under two seconds", fast.ok && (await db.cardContact.count({ where: { cardId: card.id } })) === 0);
  const neither = await pub.shareBack(card.slug, { name: "Asha Rao", elapsedMs: 5000 });
  ok("an email or a phone is needed", !neither.ok);

  const noCompany = await pub.shareBack(card.slug, base);
  const c1 = await db.cardContact.findFirst({ where: { cardId: card.id } });
  ok("without a company: a card contact, no lead", noCompany.ok && c1 !== null && c1.leadId === null);
  const repeat = await pub.shareBack(card.slug, { ...base, companyName: `${TAG} Acme` });
  ok("  the same person again that day is thanked and not added", repeat.ok && (await db.cardContact.count({ where: { cardId: card.id } })) === 1);

  const withCompany = await pub.shareBack(card.slug, { name: "Ravi Iyer", phone: "+91 91111 22222", companyName: `${TAG} Acme`, answers: ["Cards for 40 people"], elapsedMs: 5000 });
  const c2 = await db.cardContact.findFirst({ where: { cardId: card.id, name: "Ravi Iyer" }, include: { lead: true } });
  ok("with a company: a lead", withCompany.ok && !!c2?.lead);
  ok("  owned by the cardholder, from a digital card", c2?.lead?.ownerUserId === holder.id && c2?.lead?.source === "DIGITAL_CARD");
  ok("  carrying the answers", (c2?.lead?.description ?? "").includes("What are you after?: Cards for 40 people"), c2?.lead?.description);
  ok("  and the cardholder is told", (await db.notification.count({ where: { userId: holder.id } })) >= 2);

  await server.switchOffCardFor(holder.id, "manual");
  const offAnswer = await pub.shareBack(card.slug, { name: "Late Comer", email: "late@zzprobe.example", elapsedMs: 5000 });
  ok("a switched-off card takes nothing", !offAnswer.ok && (await db.cardContact.count({ where: { cardId: card.id, name: "Late Comer" } })) === 0);
  await server.issueCardsTo([holder.id], template.id, holder.id);
  moduleOn = false;
  const moduleOff = await pub.shareBack(card.slug, { name: "Late Comer", email: "late@zzprobe.example", elapsedMs: 5000 });
  ok("  nor does any card while the module is off", !moduleOff.ok);
  moduleOn = true;

  await pub.recordCardTap(card.slug);
  await pub.recordCardTap("no-such-card");
  ok("a tap is counted, and one on no card is silent", (await db.cardEvent.count({ where: { cardId: card.id, kind: "TAP" } })) === 1);

  await db.user.update({ where: { id: holder.id }, data: { active: false } });
  ok("a card whose person is switched off as an account takes nothing", !(await pub.shareBack(card.slug, { name: "X Y", email: "xy@zzprobe.example", elapsedMs: 5000 })).ok);
  ok("switchOffCardFor never throws, even for nobody", (await server.switchOffCardFor("no-such-user", "exit")) === false);
}

async function main() {
  pure();
  try {
    await withDb();
  } finally {
    await cleanup().catch((e) => console.log(" FAIL  cleanup —", e));
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll card checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
