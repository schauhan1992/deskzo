/**
 * check:cards — Deskzo Cards: digital business cards issued by HR, their public page, and the people
 * who share their details back.
 *
 * The rules first, by hand-worked cases (src/lib/cards/fields.ts, vcard.ts): what a field accepts, what
 * a card draws, a card's address, the contact file. Then a fixture of its own in the local database:
 * issuing and switching off (src/actions/card.ts), when a card is live (src/lib/cards/holder.ts),
 * the public card and sharing back (src/actions/card-public.ts) — a lead in the holder's name — the
 * limits on that, the holder's own choices, and the hand-over of what a leaver collected.
 * Everything is named ZZPROBE_CARDS and removed in a finally.
 *
 *   npm run check:cards
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "SALES", name: "Zzprobe", email: `actor${MAIL}` });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    return { useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/cards", useSearchParams: () => new URLSearchParams(), notFound: () => { throw new Error("NOT_FOUND"); } };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_CARDS";
const MAIL = "@zzprobe-cards.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const throws = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
};

/** A server component tree with its async components awaited, ready for renderToStaticMarkup. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

async function cleanup() {
  const userIds = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const cardIds = (await db.digitalCard.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((c) => c.id);
  const contactWhere = { OR: [{ cardId: { in: cardIds } }, { ownerUserId: { in: userIds } }] };
  const leadIds = (await db.cardContact.findMany({ where: { AND: [contactWhere, { leadId: { not: null } }] }, select: { leadId: true } })).map((c) => c.leadId!);
  const companyIds = (await db.lead.findMany({ where: { id: { in: leadIds } }, select: { companyId: true } })).map((l) => l.companyId);
  await db.cardContact.deleteMany({ where: contactWhere });
  await db.cardCampaign.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.cardEvent.deleteMany({ where: { cardId: { in: cardIds } } });
  await db.digitalCard.deleteMany({ where: { id: { in: cardIds } } });
  await db.cardTemplate.deleteMany({ where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: userIds } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { entityId: { in: leadIds } }] } });
  await db.lead.deleteMany({ where: { id: { in: leadIds } } });
  // The companies the share-backs made: the fixture's own people created them, whatever they are named —
  // a share-back without a company is filed under its email's domain, or as "<name> (individual)".
  const made = (await db.company.findMany({ where: { OR: [{ id: { in: companyIds } }, { createdById: { in: userIds } }] }, select: { id: true, createdById: true, name: true } }))
    .filter((c) => userIds.includes(c.createdById) || c.name.startsWith(TAG))
    .map((c) => c.id);
  await db.auditLog.deleteMany({ where: { entityId: { in: made } } });
  await db.lead.deleteMany({ where: { companyId: { in: made } } });
  await db.contact.deleteMany({ where: { companyId: { in: made } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: made } } });
  await db.company.deleteMany({ where: { id: { in: made } } });
  await db.notification.deleteMany({ where: { userId: { in: userIds } } });
  await db.userPermission.deleteMany({ where: { userId: { in: userIds } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: userIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fields = require("../src/lib/cards/fields") as typeof import("../src/lib/cards/fields");
  const vcard = require("../src/lib/cards/vcard") as typeof import("../src/lib/cards/vcard");
  const server = require("../src/lib/cards/server") as typeof import("../src/lib/cards/server");
  const holder = require("../src/lib/cards/holder") as typeof import("../src/lib/cards/holder");
  const actions = require("../src/actions/card") as typeof import("../src/actions/card");
  const pub = require("../src/actions/card-public") as typeof import("../src/actions/card-public");
  const { areaByKey } = require("../src/lib/handover/areas") as typeof import("../src/lib/handover/areas");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  const { buildNavigation } = require("../src/lib/navigation") as typeof import("../src/lib/navigation");
  const ev = require("../src/lib/cards/events") as typeof import("../src/lib/cards/events");
  const evServer = require("../src/lib/cards/events-server") as typeof import("../src/lib/cards/events-server");
  const { tenantOrigin } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const EventsPage = (require("../src/app/(dashboard)/cards/events/page") as typeof import("../src/app/(dashboard)/cards/events/page")).default;
  const EventPage = (require("../src/app/(dashboard)/cards/events/[id]/page") as typeof import("../src/app/(dashboard)/cards/events/[id]/page")).default;
  const CapturePage = (require("../src/app/(dashboard)/cards/events/[id]/capture/page") as typeof import("../src/app/(dashboard)/cards/events/[id]/capture/page")).default;
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const MyCardPage = (require("../src/app/(dashboard)/cards/page") as typeof import("../src/app/(dashboard)/cards/page")).default;
  const ManagePage = (require("../src/app/(dashboard)/cards/manage/page") as typeof import("../src/app/(dashboard)/cards/manage/page")).default;
  const render = async (page: (props: never) => Promise<unknown>, tab?: string) =>
    textOf(renderToStaticMarkup((await resolveAsync(await page({ searchParams: Promise.resolve(tab ? { tab } : {}) } as never))) as ReactElement));
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("A card's address");
  ok("a name becomes lower-case words joined by hyphens", fields.handleFrom("Anaya D'Souza") === "anaya-dsouza", fields.handleFrom("Anaya D'Souza"));
  ok("accents are dropped, not the letters", fields.handleFrom("José Müller") === "jose-muller", fields.handleFrom("José Müller"));
  ok("a name too short for an address is padded", fields.isHandle(fields.handleFrom("Al")) && fields.handleFrom("Al").startsWith("card-"), fields.handleFrom("Al"));
  ok("a very long name is cut to fit", fields.handleFrom("x".repeat(80)).length <= 34);
  ok("an address with a space, a capital or a double hyphen is not one", !fields.isHandle("bad handle") && !fields.isHandle("Bad") && !fields.isHandle("a--b") && fields.isHandle("a-b-c"));

  section("What a field accepts");
  const web = fields.checkField({ kind: "website", label: "", value: "company.com" });
  ok("a website without https:// gets it", "field" in web && web.field.value === "https://company.com/", JSON.stringify(web));
  ok("...and an empty label takes the kind's name", "field" in web && web.field.label === "Website");
  ok("a javascript: address is refused", "error" in fields.checkField({ kind: "link", value: "javascript:alert(1)" }));
  ok("a host without a dot is refused", "error" in fields.checkField({ kind: "linkedin", value: "localhost" }));
  ok("a phone number with letters is refused", "error" in fields.checkField({ kind: "phone", value: "call me" }));
  ok("an email address is lower-cased", JSON.stringify(fields.checkField({ kind: "email", value: "Priya@Company.COM" })).includes("priya@company.com"));
  ok("a kind that doesn't exist is refused", "error" in fields.checkField({ kind: "fax", value: "123" }));
  ok("stored fields read back defensively — junk dropped, never thrown", fields.readFields([{ kind: "phone", value: "+91 98765 43210" }, null, { kind: "nope" }, "x"], 12).length === 1);
  ok("WhatsApp opens wa.me with the digits", fields.hrefFor({ kind: "whatsapp", value: "+91 98765-43210" }) === "https://wa.me/919876543210");
  ok("a phone is a tel: link", fields.hrefFor({ kind: "phone", value: "+91 (22) 4000 1000" }) === "tel:+912240001000");
  ok("text reads on the card's colour: white on navy, dark on yellow", fields.inkOn("#1d4ed8") === "#ffffff" && fields.inkOn("#facc15") === "#111827");

  section("What a card draws");
  const record = { name: "Priya Sharma", title: "Sales manager", department: "Sales", company: "Acme", phone: "+91 98765 43210", email: "priya@acme.test", address: "1 MG Road", hasPhoto: true };
  const settings = fields.readRecordFields([
    { key: "photo", show: true, locked: true },
    { key: "title", show: true, locked: false },
    { key: "phone", show: true, locked: false },
    { key: "email", show: true, locked: true },
    { key: "address", show: false, locked: false },
  ]);
  ok("a template that leaves a record field out lists it, hidden", settings.length === fields.RECORD_FIELDS.length && settings.find((f) => f.key === "department")?.show === false);
  const shared = [{ kind: "website" as const, label: "Website", value: "https://acme.test/" }];
  const own = [{ kind: "linkedin" as const, label: "LinkedIn", value: "https://linkedin.com/in/priya" }];
  const drawn = fields.drawCard({ record, recordFields: settings, hidden: ["phone", "email", "photo"], shared, own, allowOwnFields: true });
  ok("the holder can hide an unlocked field (their phone)", !drawn.fields.some((f) => f.kind === "phone"));
  ok("...but not a locked one (their email, their photo)", drawn.fields.some((f) => f.kind === "email") && drawn.showPhoto);
  ok("a field the template doesn't show is never drawn (the address)", !drawn.fields.some((f) => f.kind === "address"));
  ok("record fields, then shared, then the holder's own", drawn.fields.map((f) => f.kind).join(",") === "email,website,linkedin", drawn.fields.map((f) => f.kind).join(","));
  const noOwn = fields.drawCard({ record, recordFields: settings, hidden: [], shared, own, allowOwnFields: false });
  ok("a template that takes no own fields draws none, whatever is stored", !noOwn.fields.some((f) => f.kind === "linkedin"));

  section("The contact file");
  const file = vcard.buildVCard(
    { ...drawn, name: "Priya; Sharma, Jr", title: "Head of sales, North" },
    { cardUrl: "https://acme.deskzo.com/c/priya-sharma", photo: { mimeType: "image/png", base64: "A".repeat(400) } },
  );
  const lines = file.split("\r\n");
  ok("a vCard 3.0, every line ending CRLF", lines[0] === "BEGIN:VCARD" && lines[1] === "VERSION:3.0" && file.endsWith("END:VCARD\r\n") && !/[^\r]\n/.test(file));
  ok("commas and semicolons in a name are escaped", file.includes("FN:Priya\\; Sharma\\, Jr") && file.includes("TITLE:Head of sales\\, North"));
  ok("no line is longer than 75 octets — long ones are folded", lines.every((l) => Buffer.byteLength(l, "utf8") <= 75), Math.max(...lines.map((l) => Buffer.byteLength(l, "utf8"))));
  ok("...and a folded line carries on with a space", lines.some((l) => l.startsWith(" A")));
  ok("the card's own address and the photo are in it", file.includes("URL;TYPE=Card:https://acme.deskzo.com/c/priya-sharma") && file.includes("PHOTO;ENCODING=b;TYPE=PNG:"));
  const accented = vcard.buildVCard({ ...drawn, name: "Zoë Ångström-Ñúñez " + "é".repeat(60) }, { cardUrl: "https://x.test/c/z" });
  ok("folding never splits a character in two", accented.split("\r\n").every((l) => !l.includes(String.fromCharCode(0xfffd)) && Buffer.byteLength(l, "utf8") <= 75));

  await cleanup();
  try {
    section("The fixture");
    const mk = (name: string, role = "SALES", active = true) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\s+/g, ".")}${MAIL}`, role, active, passwordHash: "x".repeat(60) } });
    const manager = await mk("Zzprobe Hr");
    await db.userPermission.create({ data: { userId: manager.id, permission: "cards.manage", allowed: true, reason: TAG } });
    const rep = await mk("Zzprobe Rep One");
    const other = await mk("Zzprobe Rep Two");
    const leaver = await mk("Zzprobe Leaver");
    const gone = await mk("Zzprobe Switched Off", "SALES", false);
    const successor = await mk("Zzprobe Successor");
    const today = (await workspaceClock()).today();
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000);
    await db.employeeProfile.create({ data: { userId: rep.id, designation: "Account manager" } });
    await db.employeeProfile.create({ data: { userId: leaver.id, exitedOn: yesterday } });
    ok("six people, one of them a card manager", true);

    section("Issuing");
    actorId = rep.id;
    const refused = await actions.issueDigitalCards({ userIds: [rep.id] });
    ok("somebody without cards.manage can't issue a card — not even their own", !refused.ok && (await db.digitalCard.count({ where: { userId: rep.id } })) === 0, JSON.stringify(refused));
    actorId = manager.id;
    const first = await actions.issueDigitalCards({ userIds: [rep.id, other.id, leaver.id, gone.id] });
    ok("a manager issues three — the switched-off account is skipped", first.ok && first.data.issued === 3 && first.data.skipped === 1, JSON.stringify(first));
    const repCard = await db.digitalCard.findUniqueOrThrow({ where: { userId: rep.id }, include: { template: true } });
    ok("the address comes from the name", repCard.handle.startsWith("zzprobe-rep-one"), repCard.handle);
    ok("from the workspace's default template (made when there was none)", repCard.template.isDefault);
    const defaultTemplateId = repCard.templateId;
    const again = await actions.issueDigitalCards({ userIds: [rep.id] });
    ok("issuing again leaves a live card as it is", again.ok && again.data.skipped === 1 && again.data.issued === 0, JSON.stringify(again));
    // The workspace's default is whatever its people made it: everything below that depends on a
    // template's settings uses the fixture's own, and the default itself is never changed.
    const fixtureMade = await actions.saveCardTemplate({ id: null, name: `${TAG} Fixture`, color: "#1d4ed8", layout: "CLASSIC", showLogo: true, recordFields: fields.DEFAULT_RECORD_FIELDS, sharedFields: [], allowOwnFields: true, shareBack: true, questions: [] });
    const fixtureTemplateId = fixtureMade.ok ? fixtureMade.data.id : "";
    const toFixture = await actions.issueDigitalCards({ userIds: [rep.id, other.id, leaver.id], templateId: fixtureTemplateId });
    ok("the fixture's cards move to a template of its own", toFixture.ok && toFixture.data.moved === 3, JSON.stringify(toFixture));
    const both = await actions.issueDigitalCards({ userIds: [rep.id], departmentId: "x" });
    ok("saying who two ways at once is refused", !both.ok);
    ok("a second default template is refused by the database", await throws(() => db.cardTemplate.create({ data: { name: `${TAG} second default`, isDefault: true } })));
    ok("an address that isn't one is refused by the database", await throws(() => db.digitalCard.update({ where: { id: repCard.id }, data: { handle: "Bad Handle" } })));
    const taken = await actions.changeCardHandle(repCard.id, (await db.digitalCard.findUniqueOrThrow({ where: { userId: other.id } })).handle);
    ok("an address another card has is refused", !taken.ok && /already/.test(taken.ok ? "" : taken.error));

    section("Live, off, left");
    ok("the rep's card is live — and the menu offers My card", await holder.holdsLiveCard(rep.id));
    const nav = (facts: ("cardholder")[]) => buildNavigation({ openModules: ["cards"], permissions: ["section.cards"], country: "IN", facts }).flatMap((s) => s.items.map((i) => i.href));
    ok("...the menu shows My card to a holder and not to anybody else", nav(["cardholder"]).includes("/cards") && !nav([]).includes("/cards"));
    ok("...and Digital cards only to whoever manages them", !nav(["cardholder"]).includes("/cards/manage"));
    ok("the leaver's card went dark the day after their last day", !(await holder.holdsLiveCard(leaver.id)));
    await db.employeeProfile.update({ where: { userId: leaver.id }, data: { exitedOn: new Date(`${today}T00:00:00Z`) } });
    ok("...and is live through the whole of the last day", await holder.holdsLiveCard(leaver.id));
    await db.employeeProfile.update({ where: { userId: leaver.id }, data: { exitedOn: yesterday } });
    const leaverCard = await db.digitalCard.findUniqueOrThrow({ where: { userId: leaver.id } });
    const leaverPublic = await server.publicCard(leaverCard.handle);
    ok("its address answers with the company, not the person", leaverPublic?.state === "gone", leaverPublic?.state);
    ok("an address that was never a card is nothing", (await server.publicCard("zzprobe-no-such-card")) === null);
    const off = await actions.switchOffCards([leaverCard.id]);
    ok("a manager switches a card off", off.ok && (await db.digitalCard.findUniqueOrThrow({ where: { id: leaverCard.id } })).status === "OFF");
    const otherCard = await db.digitalCard.findUniqueOrThrow({ where: { userId: other.id } });
    await actions.switchOffCards([otherCard.id]);
    ok("...and the menu stops offering it", !(await holder.holdsLiveCard(other.id)));
    const back = await actions.issueDigitalCards({ userIds: [other.id] });
    ok("issuing it again switches it back on, address unchanged", back.ok && back.data.switchedOn === 1 && (await db.digitalCard.findUniqueOrThrow({ where: { userId: other.id } })).handle === otherCard.handle);

    section("The public card");
    const live = await server.publicCard(repCard.handle);
    ok("a live card draws the holder's record", live?.state === "live" && live.card.name === "Zzprobe Rep One" && live.card.title === "Account manager", JSON.stringify(live?.state === "live" ? live.card : live));
    ok("...with their work email, and nothing personal", live?.state === "live" && live.card.fields.some((f) => f.kind === "email" && f.value === `zzprobe.rep.one${MAIL}`));
    await server.recordCardEvent(repCard.id, "VIEW");
    for (let i = 0; i < 40; i++) await server.recordCardEvent(repCard.id, "SAVE");
    const counted = await server.cardNumbers([repCard.id]);
    ok("views and saves are counted", counted.get(repCard.id)!.views === 1 && counted.get(repCard.id)!.saves > 0);
    ok("...but at most thirty of a kind a minute", counted.get(repCard.id)!.saves === 30, counted.get(repCard.id)!.saves);
    await pub.recordCardTap(repCard.handle, "linkedin");
    await pub.recordCardTap(repCard.handle, "not-a-kind");
    ok("a tap is counted with its kind; a made-up kind isn't", (await db.cardEvent.count({ where: { cardId: repCard.id, kind: "TAP" } })) === 1);

    section("The holder's own choices");
    actorId = rep.id;
    const badOwn = await actions.updateMyCard({ ownFields: [{ kind: "website", label: "Site", value: "not a site" }] });
    ok("an own field that isn't usable refuses the save", !badOwn.ok);
    const saved = await actions.updateMyCard({ hidden: ["title", "company", "nonsense"], ownFields: [{ kind: "whatsapp", label: "", value: "+91 98765 43210" }] });
    const afterSave = await db.digitalCard.findUniqueOrThrow({ where: { id: repCard.id } });
    ok("the holder hides their title; the locked company and a made-up field stay", saved.ok && afterSave.hidden.join(",") === "title", afterSave.hidden.join(","));
    ok("...and their WhatsApp is on the card", (await server.publicCard(repCard.handle))?.state === "live" && JSON.stringify(afterSave.ownFields).includes("whatsapp"));
    actorId = successor.id;
    ok("somebody without a card has nothing to change", !(await actions.updateMyCard({ hidden: [] })).ok);

    section("Sharing back");
    const base = { handle: repCard.handle, elapsedMs: 5000 };
    const companyName = `${TAG} Buyer Co`;
    ok("a filled hidden field is thanked and dropped", (await pub.shareBackFromCard({ ...base, name: "Bot", email: `bot${MAIL}`, website: "spam" })).ok && (await db.cardContact.count({ where: { cardId: repCard.id } })) === 0);
    ok("so is a form sent in under two seconds", (await pub.shareBackFromCard({ ...base, name: "Fast", email: `fast${MAIL}`, elapsedMs: 300 })).ok && (await db.cardContact.count({ where: { cardId: repCard.id } })) === 0);
    ok("a name is needed", !(await pub.shareBackFromCard({ ...base, name: " ", email: `x${MAIL}` })).ok);
    ok("and an email or a phone", !(await pub.shareBackFromCard({ ...base, name: "Nobody" })).ok);
    const shared1 = await pub.shareBackFromCard({ ...base, name: "Meera Buyer", email: `meera${MAIL}`, company: companyName, jobTitle: "IT head", message: "Call me" });
    const contact = await db.cardContact.findFirst({ where: { cardId: repCard.id }, include: { lead: { select: { ownerUserId: true, source: true, title: true } } } });
    ok("a person shares back: kept, in the holder's name", shared1.ok && contact?.ownerUserId === rep.id && contact.name === "Meera Buyer", JSON.stringify(shared1));
    ok("...and, with the CRM, a lead owned by the holder, from a Digital card", contact?.lead?.ownerUserId === rep.id && contact.lead.source === "DIGITAL_CARD", JSON.stringify(contact?.lead));
    ok("...which the holder is told about", (await db.notification.count({ where: { userId: rep.id } })) > 0);
    ok("...and the card counts it", (await db.cardEvent.count({ where: { cardId: repCard.id, kind: "SHARE_BACK" } })) === 1);

    actorId = manager.id;
    const template = await db.cardTemplate.findUniqueOrThrow({ where: { id: fixtureTemplateId } });
    const spec = server.readTemplate(template);
    const asked = await actions.saveCardTemplate({ ...spec, id: spec.id, questions: [{ id: "budget1", label: "Your budget?", required: true }] });
    ok("a manager adds a required question to the template", asked.ok, JSON.stringify(asked));
    const unanswered = await pub.shareBackFromCard({ ...base, name: "Ravi", phone: "+91 90000 00000" });
    ok("...and a share-back without its answer is refused", !unanswered.ok && /budget/.test(unanswered.ok ? "" : unanswered.error));
    await actions.saveCardTemplate({ ...spec, id: spec.id, questions: [] });

    for (let i = 0; i < 9; i++) await pub.shareBackFromCard({ ...base, name: `Visitor ${i}`, email: `v${i}${MAIL}`, company: companyName });
    const busy = await pub.shareBackFromCard({ ...base, name: "One too many", email: `late${MAIL}`, company: companyName });
    ok("ten share-backs a card in ten minutes, and the eleventh waits", !busy.ok && (await db.cardContact.count({ where: { cardId: repCard.id } })) === 10, busy.ok ? "accepted" : busy.error);
    const offCard = await pub.shareBackFromCard({ handle: leaverCard.handle, name: "Late", email: `late2${MAIL}`, elapsedMs: 5000 });
    ok("a card that isn't live takes nothing", !offCard.ok);

    section("The pages, rendered");
    actorId = rep.id;
    const mine = await render(MyCardPage);
    ok("My card: the card, its link and QR, and the holder's own choices", mine.includes("Zzprobe Rep One") && mine.includes(`/c/${repCard.handle}`) && mine.includes("Download QR") && mine.includes("From your record"), mine.slice(0, 300));
    ok("...with the week's numbers", /Views/.test(mine) && /Shared back/.test(mine));
    const myContacts = await render(MyCardPage, "contacts");
    ok("its Contacts tab lists who shared back, with the lead", myContacts.includes("Meera Buyer") && myContacts.includes("Open the lead"));
    actorId = successor.id;
    const none = await render(MyCardPage);
    ok("somebody without a card is told how cards are issued", none.includes("You don't have a digital card yet") && none.includes("HR or an admin issues them"), none.slice(0, 200));
    actorId = manager.id;
    const managed = await render(ManagePage);
    ok("Digital cards lists people with their card's state", managed.includes("Zzprobe Rep One") && managed.includes("Live") && managed.includes("Issue cards"), managed.slice(0, 300));
    const templatesTab = await render(ManagePage, "templates");
    ok("...and its Templates tab the templates, the default marked", templatesTab.includes("Default") && templatesTab.includes("New template"));
    actorId = rep.id;
    ok("somebody who doesn't manage cards gets a 404, not the page", await throws(() => render(ManagePage)));

    section("Notes and the hand-over");
    actorId = other.id;
    ok("somebody else can't note the rep's contact", !(await actions.saveCardContactNote(contact!.id, "mine now")).ok);
    actorId = rep.id;
    ok("the holder can", (await actions.saveCardContactNote(contact!.id, "Follow up Monday")).ok && (await db.cardContact.findUniqueOrThrow({ where: { id: contact!.id } })).note === "Follow up Monday");
    const area = areaByKey.get("card-contacts")!;
    const held = await db.$transaction((tx) => area.hold(tx, rep.id));
    ok("the hand-over lists what the rep collected", held.length === 10, held.length);
    await db.$transaction((tx) => area.give(tx, held.map((h) => h.id), successor.id, { actorId: manager.id, fromUserId: rep.id }));
    ok("...and moves it to their successor", (await db.cardContact.count({ where: { ownerUserId: successor.id } })) === 10);

    section("Templates");
    actorId = manager.id;
    const extra = await actions.saveCardTemplate({ ...spec, id: null, name: `${TAG} Events`, questions: [] });
    ok("a second template is made, not the default", extra.ok && !(await db.cardTemplate.findUniqueOrThrow({ where: { id: extra.ok ? extra.data.id : "" } })).isDefault);
    const moved = await actions.issueDigitalCards({ userIds: [rep.id], templateId: extra.ok ? extra.data.id : null });
    ok("naming a template moves a live card onto it", moved.ok && moved.data.moved === 1);
    ok("a template a card uses can't be deleted", !(await actions.deleteCardTemplate(extra.ok ? extra.data.id : "")).ok);
    ok("nor can the default", !(await actions.deleteCardTemplate(defaultTemplateId)).ok);
    const badTemplate = await actions.saveCardTemplate({ ...spec, id: spec.id, sharedFields: [{ kind: "website", label: "Site", value: "nope" }] });
    ok("a shared field that isn't usable refuses the template", !badTemplate.ok);
    await actions.issueDigitalCards({ userIds: [rep.id], templateId: spec.id });
    ok("...and one nobody uses can go", (await actions.deleteCardTemplate(extra.ok ? extra.data.id : "")).ok);

    section("Card events");
    const showName = `${TAG} Expo`;
    const draft = { id: null, name: showName, venue: "Hall 5, stand B12", startsOn: ev.addDays(today, -1), endsOn: ev.addDays(today, 1), goal: 50, cost: 20000, memberIds: [rep.id, other.id], questions: [{ id: "need1", label: "What are you looking for?", required: true }] };
    actorId = rep.id;
    ok("somebody who doesn't manage cards can't make an event", !(await actions.saveCardEvent(draft)).ok);
    actorId = manager.id;
    ok("an event can't end before it starts", !(await actions.saveCardEvent({ ...draft, startsOn: today, endsOn: ev.addDays(today, -1) })).ok);
    const made = await actions.saveCardEvent(draft);
    const show = made.ok ? await evServer.loadEvent(made.data.id) : null;
    ok("a manager makes an event, running today, with a team of two", !!show && show.state === "live" && show.memberIds.length === 2, JSON.stringify(made));
    ok("...its booth code is random letters and digits", !!show && /^[a-z0-9]{10}$/.test(show.code));
    ok("its team are told apart in the menu: the rep is on it, the successor isn't", (await holder.onEventTeam(rep.id)) && !(await holder.onEventTeam(successor.id)));

    const otherHandle = (await db.digitalCard.findUniqueOrThrow({ where: { userId: other.id } })).handle;
    const handed = await pub.shareBackFromCard({ handle: otherHandle, name: "Kiran Visitor", email: `kiran${MAIL}`, company: companyName, elapsedMs: 5000 });
    const handedRow = await db.cardContact.findFirst({ where: { email: `kiran${MAIL}` }, include: { lead: { select: { source: true, title: true, sourceDetail: true } } } });
    ok("a share-back from a team member's card on the event's days counts towards it", handed.ok && handedRow?.campaignId === show?.id && handedRow?.via === "SHARE_BACK", JSON.stringify(handed));
    ok("...and its lead says Event, and where", handedRow?.lead?.source === "EVENT" && /met at/.test(handedRow.lead.title) && (handedRow.lead.sourceDetail ?? "").includes(showName), JSON.stringify(handedRow?.lead));

    const boothNoAnswer = await pub.shareBackFromCard({ handle: repCard.handle, name: "Booth Visitor", phone: "+91 91111 22222", event: show?.code, elapsedMs: 5000 });
    ok("the booth form asks the event's questions, not the card's", !boothNoAnswer.ok && /looking for/.test(boothNoAnswer.ok ? "" : boothNoAnswer.error));
    const boothed = await pub.shareBackFromCard({ handle: repCard.handle, name: "Booth Visitor", phone: "+91 91111 22222", event: show?.code, answers: { need1: "Firewalls" }, elapsedMs: 5000 });
    const boothRow = await db.cardContact.findFirst({ where: { phone: "+91 91111 22222" } });
    ok("a visitor at the booth form: kept against the event, as the booth", boothed.ok && boothRow?.via === "BOOTH" && boothRow.campaignId === show?.id, JSON.stringify(boothed));
    ok("...past the card's ten-in-ten-minutes, which a busy stand would hit", (await db.cardContact.count({ where: { cardId: repCard.id } })) > 10);
    await actions.issueDigitalCards({ userIds: [manager.id] });
    const managerHandle = (await db.digitalCard.findUniqueOrThrow({ where: { userId: manager.id } })).handle;
    const notTeam = await pub.shareBackFromCard({ handle: managerHandle, name: "Wrong Booth", email: `wrong${MAIL}`, event: show?.code, elapsedMs: 5000 });
    const notTeamRow = await db.cardContact.findFirst({ where: { email: `wrong${MAIL}` } });
    ok("a booth code on the card of somebody not on the team is just the card", notTeam.ok && notTeamRow?.via === "SHARE_BACK" && notTeamRow.campaignId === null);

    section("Scanning at an event");
    const vcard = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Rao;Sunita;;;\r\nORG:" + TAG + " Scan Co;IT\r\nTITLE:CIO\r\nTEL;TYPE=WORK:+91 90000 11111\r\nEMAIL:Sunita@Scan.test\r\nEND:VCARD\r\n";
    const parsed = ev.parseVCard(vcard);
    ok("a vCard is read: the name from N when there's no FN, the company before its department", parsed?.name === "Sunita Rao" && parsed.company === `${TAG} Scan Co` && parsed.email === "sunita@scan.test", JSON.stringify(parsed));
    ok("a folded, escaped line is put back together", ev.parseVCard("BEGIN:VCARD\r\nFN:Ana\r\n  Lucia\r\nORG:Smith\\, Jones & Co\r\nEND:VCARD")?.company === "Smith, Jones & Co" && ev.parseVCard("BEGIN:VCARD\r\nFN:Ana\r\n  Lucia\r\nEND:VCARD")?.name === "Ana Lucia");
    ok("a MECARD is read too", (() => { const s = ev.readScan("MECARD:N:Doe,John;TEL:+91 98000 00000;EMAIL:j@d.test;;"); return s.kind === "vcard" && s.contact.name === "John Doe" && s.contact.phone === "+91 98000 00000"; })());
    ok("a card's address is recognised as a card; another address as a link; words as words", ev.readScan("https://acme.deskzo.com/c/priya-sharma").kind === "card" && ev.readScan("https://linkedin.com/in/x").kind === "url" && ev.readScan("hello").kind === "text");
    actorId = rep.id;
    const fromVcard = show ? await actions.readScannedCode(show.id, vcard) : null;
    ok("the team reads a scanned vCard into the form", fromVcard?.ok === true && fromVcard.data.name === "Sunita Rao");
    const sameWorkspace = show ? await actions.readScannedCode(show.id, `${await tenantOrigin()}/c/${otherHandle}`) : null;
    ok("...and a card of this workspace's by its address", sameWorkspace?.ok === true && sameWorkspace.data.name === "Zzprobe Rep Two", JSON.stringify(sameWorkspace));
    ok("...but nothing from an address off the platform", show ? !(await actions.readScannedCode(show.id, "https://evil.example/c/someone")).ok : false);
    const before = await db.notification.count({ where: { userId: rep.id } });
    const scanned = show ? await actions.captureEventContact({ eventId: show.id, name: "Sunita Rao", email: "sunita@scan.test", phone: "", company: `${TAG} Scan Co`, jobTitle: "CIO", note: "Wants a demo", answers: { need1: "SIEM" } }) : null;
    const scannedRow = await db.cardContact.findFirst({ where: { email: "sunita@scan.test" }, include: { lead: { select: { ownerUserId: true, source: true } } } });
    ok("a scanned person is saved as the rep's, against the event, with their lead", scanned?.ok === true && scannedRow?.via === "SCAN" && scannedRow.ownerUserId === rep.id && scannedRow.lead?.source === "EVENT", JSON.stringify(scanned));
    ok("...and nobody is told what they did themselves", (await db.notification.count({ where: { userId: rep.id } })) === before);
    const again2 = show ? await actions.captureEventContact({ eventId: show.id, name: "Sunita R", email: "SUNITA@scan.test", phone: "", company: "", jobTitle: "", note: "" }) : null;
    ok("the same person twice at one event is refused, naming who has them", again2?.ok === false && /already/.test(again2.error));
    actorId = successor.id;
    ok("somebody not on the team can't add people to it", show ? !(await actions.captureEventContact({ eventId: show.id, name: "X", email: `x2${MAIL}`, phone: "", company: "", jobTitle: "", note: "" })).ok : false);

    actorId = manager.id;
    const old = await actions.saveCardEvent({ ...draft, name: `${TAG} Old Show`, startsOn: ev.addDays(today, -20), endsOn: ev.addDays(today, -10) });
    actorId = rep.id;
    ok("ten days after an event ends, nobody can be added to it", old.ok && !(await actions.captureEventContact({ eventId: old.data.id, name: "Late", email: `late3${MAIL}`, phone: "", company: "", jobTitle: "", note: "" })).ok);

    section("Results");
    const results = show ? await evServer.eventResults(show) : null;
    ok("three met: one shared back, one at the booth, one scanned", results?.met === 3 && results.byVia.SHARE_BACK === 1 && results.byVia.BOOTH === 1 && results.byVia.SCAN === 1, JSON.stringify(results?.byVia));
    ok("...credited to who met them: two to the rep, one to the other", results?.byPerson.find((p) => p.userId === rep.id)?.met === 2 && results.byPerson.find((p) => p.userId === other.id)?.met === 1);
    ok("...today's count, and the cost per person", results?.byDay.find((d) => d.day === today)?.met === 3 && results.costPerPerson === 6666.67, JSON.stringify(results?.byDay));
    actorId = rep.id;
    ok("the team can't export", show ? !(await actions.exportEventContacts(show.id)).ok : false);
    actorId = manager.id;
    const csv = show ? await actions.exportEventContacts(show.id) : null;
    const csvLines = csv?.ok ? csv.data.csv.split("\r\n") : [];
    ok("a manager exports everybody met, with the event's question as a column", csvLines.length === 4 && csvLines[0]!.includes("What are you looking for?") && csvLines.some((l) => l.includes("SIEM")), csvLines[0]);
    ok("an event people were met at can't be deleted", show ? !(await actions.deleteCardEvent(show.id)).ok : false);
    ok("one nobody was met at can", old.ok && (await actions.deleteCardEvent(old.data.id)).ok);

    section("Event pages, rendered");
    const list = await render(EventsPage);
    ok("Card events lists it for a manager, with its count", list.includes(showName) && list.includes("New event") && /3 of 50 met/.test(list), list.slice(0, 300));
    const renderEvent = async (tab?: string) =>
      textOf(renderToStaticMarkup((await resolveAsync(await EventPage({ params: Promise.resolve({ id: show!.id }), searchParams: Promise.resolve(tab ? { tab } : {}) } as never))) as ReactElement));
    const asManager = await renderEvent();
    ok("its page: the numbers, each person, each booth form", asManager.includes("People met") && asManager.includes("Zzprobe Rep One") && asManager.includes("Booth forms") && asManager.includes("Export CSV"), asManager.slice(0, 300));
    actorId = rep.id;
    const asRep = await renderEvent("people");
    ok("the rep sees the people they met, not their teammate's", asRep.includes("Sunita Rao") && !asRep.includes("Kiran Visitor"));
    const capturePage = textOf(renderToStaticMarkup((await resolveAsync(await CapturePage({ params: Promise.resolve({ id: show!.id }) } as never))) as ReactElement));
    ok("...and can open the capture page", capturePage.includes("Add someone you met") && capturePage.includes("Your note"));
    const myCardNow = await render(MyCardPage);
    ok("My card lists the rep's event, with its booth form", myCardNow.includes("Your events") && myCardNow.includes(showName) && myCardNow.includes("Booth form"));
    actorId = successor.id;
    ok("somebody not on the team gets a 404 for the event", await throws(() => renderEvent()));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures ? `\n${failures} failed.\n` : "\nAll passed.\n");
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await cleanup();
  } catch {}
  process.exit(1);
});
