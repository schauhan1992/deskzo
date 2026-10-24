/**
 * The Customer inbox (src/lib/inbox, src/actions/inbox.ts) — website chat with its bot, and WhatsApp.
 *
 *   · The rules without a database: a channel's settings read and checked, the bot's answers and its
 *     way to a person, Meta's webhook read and its signature checked, the 24-hour window, the bubble.
 *   · A website visitor's conversation: the greeting, a set answer, asking for a person, the name and
 *     email asked for, the handover, and the lead it makes; their token is theirs alone.
 *   · WhatsApp: a new number makes a lead, a known one links to its contact and doesn't, Meta's retries
 *     are skipped, receipts only move forward, the 24 hours and templates.
 *   · Staff: who sees what (a rep's own number), replying, the bot stepping aside, assigning and being
 *     told, closing, reopening on a new message, a ticket from a conversation, unread counts, the live bus.
 *   · The actions refuse somebody without the inbox, and anybody viewing as somebody.
 *
 * On the local database, every row named Zzprobe / ZZPROBE_INBOX and removed in a finally; nothing is
 * sent to Meta (a stand-in takes every WhatsApp message).
 *
 *   npm run check:customer-inbox
 */
import "dotenv/config";
import { createHmac } from "node:crypto";
import Module from "node:module";
import path from "node:path";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ASK_NAME_LINES, botReply, contactIn, firstNameOf, matchAnswer, nameIn, smallTalkOf, typingMs, withName, type BotState, type Known } from "../src/lib/inbox/bot";

/** One of the bot's ways of asking a name. */
const asksName = (line: string | undefined) => !!line && ASK_NAME_LINES.includes(line);
import { channelSettings, checkChannelSettings, conversationRef, defaultChannelSettings, siteOrigin, whatsappWindowOpen, withinHours, type ChannelSettings } from "../src/lib/inbox/settings";
import { parseWebhook, verifySignature } from "../src/lib/inbox/whatsapp";
import { WIDGET_SCRIPT } from "../src/lib/inbox/widget-script";
import { clockFor } from "../src/lib/time/zone";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  // Only the settings page reads the request's host; tenancy needs headers() to fail outside a request, as it does.
  const from = (parent as { filename?: string } | undefined)?.filename ?? "";
  if (request === "next/headers" && from.includes(`settings${path.sep}inbox${path.sep}page`)) return { headers: async () => new Headers({ host: "zz.localhost:3000" }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/inbox",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: "SUPPORT", name: "Zzprobe", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => (viewingAs ? { user: user(), actor: user() } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_INBOX";
const MAIL = "@zzprobe-inbox.invalid";
const DOMAIN = "zzprobe-inbox.invalid";
const PHONE_IDS = ["990000000101", "990000000102", "990000000103", "990000000104", "990000000105"];
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const channels = await db.inboxChannel.findMany({ where: { OR: [{ name: { startsWith: TAG } }, { phoneNumberId: { in: PHONE_IDS } }] }, select: { id: true } });
  const conversations = await db.conversation.findMany({ where: { channelId: { in: channels.map((c) => c.id) } }, select: { companyId: true, leadId: true, ticketId: true } });
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: "Zzprobe" } }, { name: { equals: DOMAIN, mode: "insensitive" } }, { id: { in: conversations.map((c) => c.companyId).filter((v): v is string => !!v) } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  const conversationIds = (await db.conversation.findMany({ where: { channelId: { in: channels.map((c) => c.id) } }, select: { id: true } })).map((c) => c.id);
  await db.automationEvent.deleteMany({ where: { recordType: "conversation", recordId: { in: conversationIds } } });
  await db.conversation.deleteMany({ where: { channelId: { in: channels.map((c) => c.id) } } });
  await db.inboxChannel.deleteMany({ where: { id: { in: channels.map((c) => c.id) } } });
  const tickets = await db.ticket.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.ticket.deleteMany({ where: { id: { in: tickets.map((t) => t.id) } } });
  const leads = await db.lead.findMany({ where: { companyId: { in: companyIds } }, select: { id: true } });
  await db.auditLog.deleteMany({ where: { OR: [{ entityType: "Company", entityId: { in: companyIds } }, { entityType: "Lead", entityId: { in: leads.map((l) => l.id) } }, { entityType: "Ticket", entityId: { in: tickets.map((t) => t.id) } }] } });
  await db.lead.deleteMany({ where: { id: { in: leads.map((l) => l.id) } } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

/** A page, rendered as the server would, awaited all the way down (nested async components included). */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}
type Page = (props: never) => Promise<unknown>;
async function render(page: Page, searchParams: Record<string, string> = {}): Promise<string> {
  const el = await page({ params: Promise.resolve({}), searchParams: Promise.resolve(searchParams) } as never);
  return renderToStaticMarkup((await resolveAsync(el)) as ReactElement);
}
async function thrown(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** Why the bot answers a first message as it does. */
function talkReason(settings: ChannelSettings, text: string) {
  return botReply({ text, settings, state: null, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason;
}

/** A whole conversation with the bot, message by message: its replies, and where it ends up. */
function talk(settings: ChannelSettings, kind: "WEB" | "WHATSAPP", lines: string[], known: Known = { name: null, email: null, phone: null }) {
  let state: BotState | null = null;
  const said: string[] = [];
  let handover = false;
  for (const text of lines) {
    const turn = botReply({ text, settings, state, known, kind });
    said.push(...turn.replies);
    Object.assign(known, turn.learned);
    state = turn.state;
    handover = turn.handover;
  }
  return { said, handover, known, state };
}

async function main() {
  section("The rules, without a database");

  const web = defaultChannelSettings("WEB");
  ok("a new website channel: the bot on, asking for details, making leads", web.bot.on && web.bot.askDetails && web.autoLead && web.allowedSites.length === 0);
  ok("  a new WhatsApp number: the bot off until it's given answers", !defaultChannelSettings("WHATSAPP").bot.on);
  ok("a stored value with gaps reads whole, with the defaults filled in", channelSettings({ greeting: "Hello", look: { colour: "not a colour" } }, "WEB").look.colour === "#0249FE" && channelSettings({ greeting: "Hello" }, "WEB").greeting === "Hello");
  ok("  and nonsense reads as the defaults", JSON.stringify(channelSettings("nonsense", "WEB")) === JSON.stringify(web));
  ok("sites are kept as origins", siteOrigin("example.com/contact") === "https://example.com" && siteOrigin("http://shop.example.in") === "http://shop.example.in" && siteOrigin("not a site") === null);
  const refusedSettings = [
    checkChannelSettings({ bot: { answers: [{ keywords: "price", answer: "" }] } }, "WEB"),
    checkChannelSettings({ look: { colour: "blue" } }, "WEB"),
    checkChannelSettings({ allowedSites: ["nope nope"] }, "WEB"),
    checkChannelSettings({ bot: { answers: Array.from({ length: 31 }, () => ({ keywords: "a", answer: "b" })) } }, "WEB"),
  ];
  ok("settings are refused: an answer without words, a colour, a site, too many answers", refusedSettings.every((r) => !r.ok), refusedSettings.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
  const blankRow = checkChannelSettings({ bot: { answers: [{ keywords: "", answer: "" }, { keywords: "hours", answer: "9 to 6" }] } }, "WEB");
  ok("  a blank answer row is dropped, not refused", blankRow.ok && blankRow.settings.bot.answers.length === 1);
  ok("CNV-000123", conversationRef(123) === "CNV-000123");
  const now = new Date("2026-10-24T12:00:00.000Z");
  ok("WhatsApp's window: open within 24 hours of the customer's last message, shut after", whatsappWindowOpen(new Date("2026-10-23T12:30:00.000Z"), now) && !whatsappWindowOpen(new Date("2026-10-23T11:59:00.000Z"), now) && !whatsappWindowOpen(null, now));

  const answers = [
    { keywords: "price, pricing, cost", answer: "PRICE" },
    { keywords: "price list, brochure", answer: "BROCHURE" },
    { keywords: "office hours, open", answer: "HOURS" },
  ];
  ok("the answer with most of its words wins", matchAnswer("Can I get the price list?", answers) === "BROCHURE" && matchAnswer("What does it cost?", answers) === "PRICE");
  ok("  whole words only: 'opener' isn't 'open'", matchAnswer("is there a bottle opener", answers) === null && matchAnswer("Are you OPEN today?", answers) === "HOURS");
  ok("a phone number or an email is found in what they type", contactIn("call me on +91 98765 43210 please").phone === "+919876543210" && contactIn("mail zz@Example.com").email === "zz@example.com" && !contactIn("my order 12345").phone);
  ok("a name from 'I'm Priya' or 'my name is Priya Sharma'", nameIn("I'm Priya") === "Priya" && nameIn("my name is Priya Sharma.") === "Priya Sharma" && nameIn("98765 43210") === null);

  const bot: ChannelSettings = { ...web, bot: { ...web.bot, answers } };
  const answered = talk(bot, "WEB", ["How much does it cost?"]);
  ok("a set answer, then — the first time — a check-in, and the bot keeps the conversation", answered.said[0] === "PRICE" && answered.said.length === 2 && /anything else/i.test(answered.said[1] ?? "") && !answered.handover);
  const twice = talk(bot, "WEB", ["What does it cost?", "And the price?"]);
  ok("  the check-in only after the first answer", twice.said.length === 3 && twice.said[2] === "PRICE");
  const handed = talk(bot, "WEB", ["Do you integrate with SAP?", "I'm Zz Visitor", "zz@example.com"]);
  ok(
    "a question it can't answer: its name asked, then a way to reach them (by name), then a person",
    asksName(handed.said[0]) && /Zz/.test(handed.said[1] ?? "") && /number or email|phone number or email/i.test(handed.said[1] ?? "") && handed.handover && handed.said[2] === withName(bot.bot.handover, "Zz") && handed.known.name === "Zz Visitor" && handed.known.email === "zz@example.com",
    handed.said.join(" / "),
  );
  const person = talk(bot, "WEB", ["Can I talk to a person? I'm on 9876543210"]);
  ok("asking for a person goes the same way, keeping a number given unasked", asksName(person.said[0]) && person.known.phone === "9876543210");
  const wa = talk(bot, "WHATSAPP", ["agent please", "Zz Customer"], { name: null, email: null, phone: "+919800000000" });
  ok("on WhatsApp the number is known: only the name is asked", wa.handover && wa.said.length === 2 && asksName(wa.said[0]));
  const stubborn = talk(bot, "WEB", ["agent", "Zz Visitor", "no", "still no"]);
  ok("no phone number or email after asking twice: handed over all the same", stubborn.handover);
  const quick = talk({ ...bot, bot: { ...bot.bot, askDetails: false } }, "WEB", ["agent"]);
  ok("with nothing to ask, straight to a person — the handover without a name it doesn't know", quick.handover && quick.said.join() === withName(bot.bot.handover, null) && !quick.said.join().includes("{name}"));

  section("Talking like a person");
  ok("small talk is recognised whole: a greeting, thanks, goodbye, okay, 'are you a bot?'", smallTalkOf("Hi!") === "hello" && smallTalkOf("namaste 🙏") === "hello" && smallTalkOf("ok thanks") === "thanks" && smallTalkOf("bye") === "bye" && smallTalkOf("👍") === "ack" && smallTalkOf("are you a real person?") === "bot");
  ok("  but not inside a question", smallTalkOf("hi, what does it cost?") === null && smallTalkOf("thanks, but where do you deliver?") === null);
  const hello = talk(bot, "WEB", ["hello"]);
  ok("a greeting gets a greeting back — not a handover", !hello.handover && /hi|hello|hey/i.test(hello.said[0] ?? "") && botReply({ text: "hello", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason === "smalltalk");
  const named = botReply({ text: "thank you", settings: bot, state: null, known: { name: "Priya Sharma", email: null, phone: null }, kind: "WEB", seed: "s" });
  ok("  thanks gets 'you're welcome', by their first name once known", !named.handover && /welcome|happy to help/i.test(named.replies[0] ?? "") && named.replies[0]!.includes("Priya") && !named.replies[0]!.includes("Sharma"));
  const honest = botReply({ text: "Am I talking to a bot?", settings: { ...bot, bot: { ...bot.bot, name: "Asha" } }, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "x" });
  ok("asked whether it's a person, it says it's the virtual assistant — by its name — and offers the team", !honest.handover && honest.replies[0]!.includes("Asha") && /virtual assistant/i.test(honest.replies[0]!) && !/i('m| am) (a )?human/i.test(honest.replies[0]!));
  const lines = new Set(["a", "b", "c", "d", "e", "f"].map((s) => botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: s }).replies[0]));
  ok("it says things more than one way, by the conversation — and the same way for the same seed", lines.size > 1 && botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "a" }).replies[0] === botReply({ text: "agent", settings: bot, state: null, known: { name: null, email: null, phone: null }, kind: "WEB", seed: "a" }).replies[0]);
  ok("{name}: their first name, or left out comma and all", withName("Thanks, {name}! Back soon.", "Ravi") === "Thanks, Ravi! Back soon." && withName("Thanks, {name}! Back soon.", null) === "Thanks! Back soon." && firstNameOf("  Ravi Kumar ") === "Ravi");
  ok("'hello' isn't taken for a name, nor 'ok'", nameIn("hello") === null && nameIn("ok") === null);
  ok("a person's typing time: a beat, then by length, never long", typingMs("Hi") === 900 && typingMs("x".repeat(100)) === 2700 && typingMs("x".repeat(2000)) === 3200);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aiBrief = (require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai")).aiSystemPrompt({ ...bot, bot: { ...bot.bot, name: "Asha", ai: { on: true, about: "x", chargedTo: "u" } } }, "Zz", "Priya");
  ok("the AI is told to chat like a person, by the customer's name, honest that it's the assistant", /support agent/i.test(aiBrief) && aiBrief.includes("Priya") && aiBrief.includes("Asha") && /never say you are human/i.test(aiBrief));

  const SECRET = "0123456789abcdef0123456789abcdef";
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: "123" },
              contacts: [{ wa_id: "919800000001", profile: { name: "Zz Wa" } }],
              messages: [
                { from: "919800000001", id: "wamid.a", timestamp: "1761300000", type: "text", text: { body: "Hello" } },
                { from: "919800000001", id: "wamid.b", timestamp: "1761300001", type: "image", image: { caption: "my bill" } },
                { from: "919800000001", id: "wamid.c", timestamp: "1761300002", type: "reaction", reaction: { emoji: "👍" } },
              ],
              statuses: [
                { id: "wamid.out1", status: "read" },
                { id: "wamid.out2", status: "failed", errors: [{ title: "Re-engagement message" }] },
              ],
            },
          },
        ],
      },
    ],
  });
  const parsed = parseWebhook(JSON.parse(body));
  ok("Meta's webhook: a text, a photo with its caption, no reaction; its sender's name", parsed.messages.length === 2 && parsed.messages[0].text === "Hello" && parsed.messages[1].text === "[Photo] my bill" && parsed.messages[0].profileName === "Zz Wa" && parsed.messages[0].phoneNumberId === "123");
  ok("  receipts: read, and failed with Meta's reason", parsed.statuses.length === 2 && parsed.statuses[0].status === "READ" && parsed.statuses[1].error === "Re-engagement message");
  ok("  anything that isn't a WhatsApp account's is ignored", parseWebhook({ object: "page", entry: [] }).messages.length === 0);
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  ok("the signature: the app secret's HMAC of the body, and nothing else", verifySignature(body, signature, SECRET) && !verifySignature(`${body} `, signature, SECRET) && !verifySignature(body, signature, "f".repeat(32)) && !verifySignature(body, null, SECRET));
  ok("the bubble's script is whole JavaScript, talking only to its own workspace", !WIDGET_SCRIPT.includes("${") && WIDGET_SCRIPT.includes("/api/inbox/public/web/") && WIDGET_SCRIPT.includes('credentials: "omit"'));

  section("Phase 2's rules: why the bot hands over, office hours, the AI's brief, media");
  ok("the bot says why: a set answer, asked for a person, nothing fitted, taking details", talkReason(bot, "What does it cost?") === "answer" && talkReason(bot, "agent please") === "asked" && talkReason(bot, "Do you do SAP?") === "unknown" && botReply({ text: "Zz", settings: bot, state: { step: "name" }, known: { name: null, email: null, phone: null }, kind: "WEB" }).reason === "details");
  const hours = { ...web.hours, on: true };
  ok("office hours: in on a weekday's hours, out at closing, out on a closed Sunday", withinHours(hours, { weekday: 1, hour: 10, minute: 0 }) && !withinHours(hours, { weekday: 1, hour: 18, minute: 0 }) && !withinHours(hours, { weekday: 0, hour: 11, minute: 0 }) && withinHours(web.hours, { weekday: 0, hour: 3, minute: 0 }));
  const badHours = [
    checkChannelSettings({ hours: { on: true, days: { mon: { from: "25:00", to: "18:00" } } } }, "WEB"),
    checkChannelSettings({ hours: { on: true, days: { mon: { from: "18:00", to: "09:00" } } } }, "WEB"),
    checkChannelSettings({ bot: { ai: { on: true, about: "" } } }, "WEB"),
    checkChannelSettings({ bot: { ai: { on: true, about: "x".repeat(3001) } } }, "WEB"),
  ];
  ok("refused: a time that isn't one, closing before opening, the AI with nothing to go on, too long a brief", badHours.every((r) => !r.ok), badHours.map((r) => (r.ok ? "ok" : r.error)).join(" | "));
  const spoofed = checkChannelSettings({ bot: { answers: [{ keywords: "a", answer: "b" }], ai: { on: true, about: "We sell paint.", chargedTo: "someone" } } }, "WEB");
  ok("  a brief is kept as given (who it's charged to is the server's to set)", spoofed.ok && spoofed.settings.bot.ai.about === "We sell paint.");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aiLib = require("../src/lib/inbox/ai") as typeof import("../src/lib/inbox/ai");
  const turns = aiLib.aiHistory([
    { author: "BOT", body: "Hi!" },
    { author: "CUSTOMER", body: "Do you deliver?" },
    { author: "CUSTOMER", body: "To Pune?" },
    { author: "SYSTEM", body: "x took it" },
  ]);
  ok("the AI sees the conversation taking turns, starting with the customer, without staff's notes", turns.length === 1 && turns[0].role === "user" && turns[0].text === "Do you deliver?\nTo Pune?");
  const brief = aiLib.aiSystemPrompt({ ...bot, bot: { ...bot.bot, ai: { on: true, about: "We deliver across Maharashtra.", chargedTo: "x" } } }, "Zz Traders");
  ok("  its brief: the business, the set answers, the notes, and when to hand over", brief.includes("Zz Traders") && brief.includes("PRICE") && brief.includes("We deliver across Maharashtra.") && brief.includes(aiLib.HANDOVER_MARK));
  const photo = parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ value: { metadata: { phone_number_id: "1" }, messages: [{ from: "91", id: "w1", type: "image", image: { id: "media-1", mime_type: "image/jpeg; codecs=x", caption: "bill" } }] } }] }] });
  ok("a photo's media id comes with it, its type without parameters", photo.messages[0]?.media?.id === "media-1" && photo.messages[0]?.media?.mime === "image/jpeg");

  section("Response times: the arithmetic");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const reportLib = require("../src/lib/inbox/report") as typeof import("../src/lib/inbox/report");
  ok("median and the 90th percentile, nearest rank; nothing for none", reportLib.median([5, 1, 3]) === 3 && reportLib.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90) === 9 && reportLib.median([]) === null);
  ok("the share within a target", reportLib.shareWithin([1, 2, 10], 2) === 2 / 3 && reportLib.shareWithin([], 5) === null);
  const ist = clockFor("Asia/Kolkata");
  const weekdays = { ...web.hours, on: true };
  const at = (d: number, h: number, m: number) => ist.at(2026, 9, d, h, m);
  const MIN = 60_000;
  ok("office-hours time: Monday 17:30 answered Tuesday 09:15 is 45 minutes", reportLib.officeMs(at(26, 17, 30), at(27, 9, 15), weekdays, ist) === 45 * MIN);
  ok("  a Saturday message answered Monday 09:10 is 10 minutes", reportLib.officeMs(at(24, 11, 0), at(26, 9, 10), weekdays, ist) === 10 * MIN);
  ok("  without office hours it's the clock's time", reportLib.officeMs(at(24, 11, 0), at(26, 9, 10), web.hours, ist) === at(26, 9, 10).getTime() - at(24, 11, 0).getTime());
  const t = (m: number) => new Date(Date.UTC(2026, 9, 24, 10, m));
  const waits = reportLib.replyWaits([
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(0) },
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(2) },
    { conversationId: "a", author: "AGENT", userId: "u1", at: t(5) },
    { conversationId: "a", author: "AGENT", userId: "u1", at: t(6) },
    { conversationId: "a", author: "CUSTOMER", userId: null, at: t(10) },
    { conversationId: "a", author: "AGENT", userId: "u2", at: t(30) },
  ]);
  ok("every reply's wait runs from the first message the team hadn't answered; a second reply in a row isn't a wait", waits.length === 2 && waits[0].at.getTime() - waits[0].from.getTime() === 5 * MIN && waits[1].userId === "u2" && waits[1].at.getTime() - waits[1].from.getTime() === 20 * MIN);
  ok("durations as people say them", reportLib.durationText(45_000) === "45 s" && reportLib.durationText(12 * MIN) === "12 min" && reportLib.durationText(185 * MIN) === "3 h 5 min" && reportLib.durationText(52 * 60 * MIN) === "2 d 4 h" && reportLib.durationText(null) === "—");

  /* eslint-disable @typescript-eslint/no-require-imports */
  const server = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
  const whatsapp = require("../src/lib/inbox/whatsapp") as typeof import("../src/lib/inbox/whatsapp");
  const actions = require("../src/actions/inbox") as typeof import("../src/actions/inbox");
  const bus = require("../src/lib/chat/bus") as typeof import("../src/lib/chat/bus");
  const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
  const { setTestPlatformMailer } = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const sent: import("../src/lib/inbox/whatsapp").WhatsAppOutbound[] = [];
  let failNext: string | null = null;
  whatsapp.setTestWhatsAppSender(async (m) => {
    if (failNext) {
      const error = failNext;
      failNext = null;
      return { ok: false, error };
    }
    sent.push(m);
    return { ok: true, id: `wamid.zzout${sent.length}` };
  });
  setTestPlatformMailer(async () => {});
  // No pauses between the bot's messages here, and every read receipt and "typing…" kept instead of sent.
  server.setInboxPacing(false);
  const reads: { messageId: string; typing: boolean }[] = [];
  whatsapp.setTestWhatsAppRead(async ({ messageId, typing }) => {
    reads.push({ messageId, typing });
    return true;
  });

  await cleanup();
  try {
    const user = (name: string, role: string) => db.user.create({ data: { name: `Zzprobe ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: role as never, active: true, passwordHash: "!zzprobe-no-sign-in" }, select: { id: true } });
    const [agent, rep, manager, outsider, admin] = [await user("Agent", "SUPPORT"), await user("Rep", "SALES"), await user("Manager", "MANAGEMENT"), await user("Outsider", "ACCOUNTS"), await user("Admin", "ADMIN")];
    const A = { id: agent.id, viewAll: false };
    const R = { id: rep.id, viewAll: false };
    const M = { id: manager.id, viewAll: true };

    section("Who may use it");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    ok("support, sales and management answer customer conversations; accounts doesn't", (await can(agent.id, "inbox.view")) && (await can(rep.id, "inbox.view")) && (await can(manager.id, "inbox.view")) && !(await can(outsider.id, "inbox.view")));
    ok("  only management sees every one", (await can(manager.id, "inbox.viewAll")) && !(await can(agent.id, "inbox.viewAll")));

    const webChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} site`, publicKey: `zzprobe${Date.now()}`, settings: bot as object, createdById: manager.id } });
    const shared = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} shared`, phoneNumberId: PHONE_IDS[0], settings: defaultChannelSettings("WHATSAPP") as object, createdById: manager.id } });
    const own = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} rep`, phoneNumberId: PHONE_IDS[1], ownerUserId: rep.id, settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false } as object, createdById: manager.id } });
    const tenantId = await tenantKey();
    const heard: string[] = [];
    const unsubscribe = bus.subscribe(tenantId, agent.id, (e) => e.type === "inbox" && heard.push(e.conversationId));

    section("A website visitor and the bot");
    const first = await server.receiveWebMessage(webChannel, { text: "How much does it cost?", pageUrl: "https://example.com/pricing" });
    const seen1 = (await server.webMessages(webChannel.id, first.token, null)) ?? [];
    ok("a new conversation: the greeting, their message, the set answer, a check-in", seen1.slice(0, 3).map((m) => `${m.from}:${m.body}`).join(" | ") === `bot:${bot.greeting} | you:How much does it cost? | bot:PRICE` && seen1.length === 4 && seen1[3].from === "bot", seen1.map((m) => m.body).join(" | "));
    ok("  the token is theirs alone: a wrong one, or another channel's, reads nothing", (await server.webMessages(webChannel.id, "x".repeat(32), null)) === null && (await server.webMessages(shared.id, first.token, null)) === null);
    ok("  and the change was announced, by id", heard.includes(first.conversationId));
    const again = await server.receiveWebMessage(webChannel, { token: first.token, text: "Can I speak to someone?" });
    ok("the same token keeps the same conversation", again.conversationId === first.conversationId && again.token === first.token);
    await server.receiveWebMessage(webChannel, { token: first.token, text: "I'm Zzprobe Visitor" });
    await server.receiveWebMessage(webChannel, { token: first.token, text: `zz-visitor@${DOMAIN}` });
    const visitor = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId }, include: { lead: { select: { source: true, leadSeq: true } } } });
    ok("the bot asked, learned their name and email, and handed over", !visitor.botActive && visitor.customerName === "Zzprobe Visitor" && visitor.customerEmail === `zz-visitor@${DOMAIN}`);
    ok("  and a lead was made, from the website chat", visitor.lead?.source === "LIVE_CHAT" && !!visitor.contactId && !!visitor.companyId, visitor.lead ? `L${visitor.lead.leadSeq}` : "no lead");

    section("Staff and the website conversation");
    const queue = await server.listConversations(A, { view: "unassigned" });
    const row = queue.find((r) => r.id === first.conversationId);
    ok("it waits in the queue, unread", !!row && row.unread && row.customer === "Zzprobe Visitor" && row.kind === "WEB");
    const detail = await server.conversationDetail(A, first.conversationId);
    ok("opened: every message, and the lead on file", !!detail && detail.messages.length >= 8 && !!detail.lead && detail.windowOpen);
    ok("  and now read", !(await server.listConversations(A, { view: "unassigned" })).find((r) => r.id === first.conversationId)?.unread);
    const reply = await server.staffReply(A, first.conversationId, "Hi, Agent here — happy to help.");
    const afterReply = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    ok("a reply: kept, theirs now, the first response timed", reply.ok && afterReply.assignedToUserId === agent.id && !!afterReply.firstResponseAt);
    const visitorSees = (await server.webMessages(webChannel.id, first.token, null)) ?? [];
    ok("  the visitor sees it, with a first name only", visitorSees.some((m) => m.from === "agent" && m.name === "Zzprobe" && m.body.startsWith("Hi, Agent here")));
    ok("  and none of staff's notes to each other", visitorSees.every((m) => m.from !== ("system" as never)));
    ok("an empty reply, or a long one, is refused", !(await server.staffReply(A, first.conversationId, "   ")).ok && !(await server.staffReply(A, first.conversationId, "x".repeat(2001))).ok);

    section("WhatsApp");
    const at = new Date();
    const newNumber = { phoneNumberId: PHONE_IDS[0], from: "919900000901", profileName: "Zzprobe Wa", id: `wamid.zzin${Date.now()}`, at, text: "Hello, do you deliver to Pune?" };
    ok("a message from a new number is kept", (await server.receiveWhatsApp(newNumber)) === "stored");
    ok("  Meta's retry of it is skipped", (await server.receiveWhatsApp(newNumber)) === "duplicate");
    ok("  a number the inbox doesn't have is left alone", (await server.receiveWhatsApp({ ...newNumber, phoneNumberId: "990000000999", id: `${newNumber.id}x` })) === "no-channel");
    const waConv = await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000901" }, include: { lead: { select: { source: true } } } });
    ok("a lead from its first message, from WhatsApp, with the profile name and number", waConv.lead?.source === "WHATSAPP" && waConv.customerName === "Zzprobe Wa" && waConv.customerPhone === "+919900000901");
    ok("  the bot is off on a new number, so nothing was sent", sent.length === 0 && !waConv.botActive);

    const known = await db.company.create({ data: { name: "Zzprobe Known Co", normalizedName: `zzprobe known co ${Date.now()}`, relationshipType: "CLIENT", createdById: manager.id, ownerUserId: agent.id }, select: { id: true } });
    const contact = await db.contact.create({ data: { companyId: known.id, name: "Zzprobe Known Person", phone: "+91 99000 00902" } as never, select: { id: true } });
    await server.receiveWhatsApp({ ...newNumber, from: "919900000902", profileName: "Someone", id: `wamid.zzknown${Date.now()}`, text: "Hi again" });
    const linked = await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000902" } });
    ok("a number already on file links to its contact — however it was typed — and makes no lead", linked.contactId === contact.id && linked.companyId === known.id && !linked.leadId);

    const replyWa = await server.staffReply(A, waConv.id, "Yes, we do!");
    ok("a reply on WhatsApp goes out through Meta, from the conversation's number", replyWa.ok && sent.length === 1 && "text" in sent[0] && sent[0].phoneNumberId === PHONE_IDS[0] && sent[0].to === "919900000901");
    const outId = "wamid.zzout1";
    await server.applyWhatsAppStatus({ id: outId, status: "DELIVERED", error: null });
    await server.applyWhatsAppStatus({ id: outId, status: "READ", error: null });
    await server.applyWhatsAppStatus({ id: outId, status: "DELIVERED", error: null });
    ok("receipts only move forward: read stays read", (await db.conversationMessage.findUniqueOrThrow({ where: { externalId: outId } })).delivery === "READ");
    failNext = "Meta said no";
    const failed = await server.staffReply(A, waConv.id, "This one fails");
    ok("a send Meta refuses is refused here too, and not kept", !failed.ok && failed.error === "Meta said no" && !(await db.conversationMessage.findFirst({ where: { conversationId: waConv.id, body: "This one fails" } })));
    await db.conversation.update({ where: { id: waConv.id }, data: { lastCustomerAt: new Date(Date.now() - 25 * 3_600_000) } });
    const late = await server.staffReply(A, waConv.id, "Still there?");
    ok("over 24 hours since they wrote: free text is refused", !late.ok && /24 hours/.test(late.error));
    ok("  a template's name must be Meta's, and every value filled", !(await server.staffTemplate(A, waConv.id, { name: "Order Update", variables: [] })).ok && !(await server.staffTemplate(A, waConv.id, { name: "order_update", variables: ["Zz", ""] })).ok);
    const template = await server.staffTemplate(A, waConv.id, { name: "order_update", variables: ["Zz", "42"] });
    ok("  a template goes", template.ok && "template" in sent[sent.length - 1] && (sent[sent.length - 1] as { template: { name: string; variables: string[] } }).template.variables.join() === "Zz,42");

    section("A rep's own number");
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[1], from: "919900000903", profileName: "Zzprobe Own", id: `wamid.zzown${Date.now()}`, at: new Date(), text: "Hi, it's me" });
    const ownConv = await db.conversation.findFirstOrThrow({ where: { channelId: own.id } });
    ok("theirs from the start, and they are told", ownConv.assignedToUserId === rep.id && (await db.notification.count({ where: { userId: rep.id, type: "INBOX_MESSAGE" } })) === 1);
    ok("  this channel makes no leads", !ownConv.leadId);
    ok("a colleague can't see it, open it or reply", !(await server.listConversations(A, { view: "open" })).some((r) => r.id === ownConv.id) && (await server.conversationDetail(A, ownConv.id)) === null && !(await server.staffReply(A, ownConv.id, "hi")).ok);
    ok("  the rep and management can", (await server.listConversations(R, { view: "mine" })).some((r) => r.id === ownConv.id) && (await server.conversationDetail(M, ownConv.id)) !== null);

    section("Assigning, closing, tickets");
    ok("it can't go to somebody who doesn't answer customers", !(await server.assignConversation(A, waConv.id, outsider.id)).ok);
    const given = await server.assignConversation(A, waConv.id, rep.id);
    ok("given to a colleague: theirs, a note in the conversation, and they're told", given.ok && (await db.conversation.findUniqueOrThrow({ where: { id: waConv.id } })).assignedToUserId === rep.id && (await db.notification.count({ where: { userId: rep.id, type: "INBOX_MESSAGE" } })) === 2 && !!(await db.conversationMessage.findFirst({ where: { conversationId: waConv.id, author: "SYSTEM", body: { contains: "gave it to" } } })));
    ok("closed", (await server.setConversationStatus(A, first.conversationId, "CLOSED")).ok && (await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).status === "CLOSED");
    await server.receiveWebMessage(webChannel, { token: first.token, text: "One more thing" });
    ok("  and reopened by the customer writing again", (await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).status === "OPEN");
    ok("a ticket needs a customer on file", !(await server.staffMakeTicket(A, ownConv.id, "Help")).ok);
    // The account is whoever the assignment rules gave the lead to: management reaches it, and opens the ticket.
    const ticket = await server.staffMakeTicket(M, first.conversationId, "Zzprobe needs help");
    ok("a ticket from a linked conversation, with what was said", ticket.ok && !!(await db.ticket.findFirst({ where: { title: "Zzprobe needs help", description: { contains: "How much does it cost?" } } })), ticket.ok ? "" : ticket.error);
    ok("  only once", !(await server.staffMakeTicket(M, first.conversationId, "Again")).ok);
    const lead = await server.staffMakeLead(A, waConv.id);
    ok("making a lead where there is one gives that one", lead.ok && lead.reference !== null && lead.leadId === waConv.leadId);

    section("Phase 2: Deskzo AI, office hours, round-robin, workflows, files");
    // Deskzo AI through the inbox's stand-in: nothing ever reaches a model.
    const asked: { system: string; last: string; chargedTo: string }[] = [];
    let aiSays = "We deliver across India in 3–5 days.";
    aiLib.setTestInboxAi(async ({ system, history, chargedTo }) => {
      const last = history[history.length - 1];
      asked.push({ system, last: last && last.role === "user" ? last.text : "", chargedTo });
      return aiSays;
    });
    const aiSettings = { ...bot, bot: { ...bot.bot, ai: { on: true, about: "We deliver across India.", chargedTo: admin.id } } };
    const aiChannel = await db.inboxChannel.create({ data: { kind: "WEB", name: `${TAG} ai`, publicKey: `zzprobeai${Date.now()}`, settings: aiSettings as object, createdById: admin.id } });
    const aiConv = await server.receiveWebMessage(aiChannel, { text: "Do you deliver to Kerala?" });
    const aiSeen = (await server.webMessages(aiChannel.id, aiConv.token, null)) ?? [];
    ok("a question the set answers don't cover: Deskzo AI answers, and the bot keeps the conversation", aiSeen.some((m) => m.from === "bot" && m.body === aiSays) && (await db.conversation.findUniqueOrThrow({ where: { id: aiConv.conversationId } })).botActive);
    ok("  told the brief and the customer's words, charged as whoever switched it on", asked.length === 1 && asked[0].system.includes("We deliver across India.") && asked[0].last === "Do you deliver to Kerala?" && asked[0].chargedTo === admin.id);
    await server.receiveWebMessage(aiChannel, { token: aiConv.token, text: "What does it cost?" });
    ok("  a set answer still comes first, without asking the AI", asked.length === 1);
    aiSays = "HANDOVER";
    await server.receiveWebMessage(aiChannel, { token: aiConv.token, text: "Can you fix my broken order?" });
    const afterAi = (await server.webMessages(aiChannel.id, aiConv.token, null)) ?? [];
    ok("when it isn't sure, the bot goes towards a person (asking their name first)", asksName(afterAi[afterAi.length - 1]?.body));
    await server.receiveWebMessage(webChannel, { text: "Do you deliver to Goa?" });
    ok("a channel without the AI never asks it", asked.length === 2);

    actorId = admin.id;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const adminActions = require("../src/actions/inbox-admin") as typeof import("../src/actions/inbox-admin");
    const saved = await adminActions.saveInboxChannel({ id: aiChannel.id, kind: "WEB", name: `${TAG} ai`, settings: { ...aiSettings, bot: { ...aiSettings.bot, ai: { on: true, about: "Paint.", chargedTo: outsider.id } } } });
    ok("the AI is charged as whoever switched it on — never whom the form names", saved.ok && channelSettings((await db.inboxChannel.findUniqueOrThrow({ where: { id: aiChannel.id } })).settings, "WEB").bot.ai.chargedTo === admin.id, saved.ok ? "" : saved.error);
    await adminActions.saveInboxChannel({ id: aiChannel.id, kind: "WEB", name: `${TAG} ai`, settings: { ...aiSettings, bot: { ...aiSettings.bot, ai: { on: false, about: "Paint.", chargedTo: admin.id } } } });
    ok("  switched off, it's charged to nobody", channelSettings((await db.inboxChannel.findUniqueOrThrow({ where: { id: aiChannel.id } })).settings, "WEB").bot.ai.chargedTo === null);
    actorId = "";

    const closed = { on: true, days: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, away: "Zz — we're away" };
    const awayChannel = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} away`, phoneNumberId: PHONE_IDS[2], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, hours: closed } as object, createdById: admin.id } });
    const sentBefore = sent.length;
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[2], from: "919900000904", profileName: "Zzprobe Late", id: `wamid.zzaway${Date.now()}`, at: new Date(), text: "Hello?" });
    const awayConv = await db.conversation.findFirstOrThrow({ where: { channelId: awayChannel.id } });
    const lastSent = sent[sent.length - 1];
    ok("outside office hours a customer waiting for a person is told so", sent.length === sentBefore + 1 && !!lastSent && "text" in lastSent && lastSent.text === "Zz — we're away" && !!awayConv.awayNoticeAt);
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[2], from: "919900000904", profileName: "Zzprobe Late", id: `wamid.zzaway2${Date.now()}`, at: new Date(), text: "Anyone?" });
    ok("  once — not again on their next message", sent.length === sentBefore + 1);

    const turnsChannel = await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} turns`, phoneNumberId: PHONE_IDS[3], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, assign: { mode: "rotate", people: [agent.id, rep.id] } } as object, createdById: admin.id } });
    const inTurn: (string | null)[] = [];
    for (let i = 0; i < 3; i += 1) {
      await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[3], from: `91990000091${i}`, profileName: `Zzprobe Turn ${i}`, id: `wamid.zzturn${i}${Date.now()}`, at: new Date(), text: "Hi" });
      inTurn.push((await db.conversation.findFirstOrThrow({ where: { channelId: turnsChannel.id, waId: `91990000091${i}` } })).assignedToUserId);
    }
    ok("round-robin: each new conversation to the next person, and round again", inTurn.join() === [agent.id, rep.id, agent.id].join());
    ok("  with a note in the conversation, and the person told it's their turn", !!(await db.conversationMessage.findFirst({ where: { conversation: { channelId: turnsChannel.id }, author: "SYSTEM", body: { contains: "in turn" } } })) && (await db.notification.count({ where: { userId: agent.id, type: "INBOX_MESSAGE", title: { contains: "your turn" } } })) === 2);

    const events = await db.automationEvent.findMany({ where: { recordType: "conversation", recordId: { in: [aiConv.conversationId, awayConv.id] } }, select: { type: true, recordId: true, payload: true } });
    ok("workflows hear of it: a conversation started; one that needs a person", events.some((e) => e.recordId === aiConv.conversationId && e.type === "conversation.started") && events.some((e) => e.recordId === awayConv.id && e.type === "conversation.needs_person") && !events.some((e) => e.recordId === aiConv.conversationId && e.type === "conversation.needs_person"));
    const startedPayload = JSON.stringify(events.find((e) => e.recordId === awayConv.id && e.type === "conversation.started")?.payload ?? {});
    ok("  with what a workflow needs: its number, the customer, the first message", startedPayload.includes("CNV-") && startedPayload.includes("Zzprobe Late") && startedPayload.includes("Hello?"));

    let fetches = 0;
    whatsapp.setTestWhatsAppMedia(async (mediaId) => {
      fetches += 1;
      return mediaId === "zz-media-1" ? { ok: true, bytes: Buffer.from("zz-jpeg-bytes"), mime: "image/jpeg" } : { ok: false, error: "WhatsApp no longer has this file." };
    });
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[0], from: "919900000901", profileName: "Zzprobe Wa", id: `wamid.zzphoto${Date.now()}`, at: new Date(), text: "[Photo] my bill", media: { id: "zz-media-1", mime: "image/jpeg", name: null } });
    const photoMsg = await db.conversationMessage.findFirstOrThrow({ where: { mediaId: "zz-media-1" } });
    const opened = await server.conversationFile(A, photoMsg.id);
    const openedAgain = await server.conversationFile(A, photoMsg.id);
    ok("a photo: fetched from WhatsApp the first time it's opened, kept after that", opened.ok && opened.bytes.toString() === "zz-jpeg-bytes" && openedAgain.ok && fetches === 1);
    ok("  and shown in its conversation", (await server.conversationDetail(A, photoMsg.conversationId))?.messages.some((m) => m.id === photoMsg.id && m.media?.mime === "image/jpeg") === true);
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[1], from: "919900000903", profileName: "Zzprobe Own", id: `wamid.zzpdf${Date.now()}`, at: new Date(), text: "[Document: quote.pdf]", media: { id: "zz-media-2", mime: "application/pdf", name: "quote.pdf" } });
    const ownFile = await db.conversationMessage.findFirstOrThrow({ where: { mediaId: "zz-media-2" } });
    const notYours = await server.conversationFile(A, ownFile.id);
    ok("  a file in a conversation somebody can't see is not found, and not fetched", !notYours.ok && notYours.status === 404 && fetches === 1);
    const gone = await server.conversationFile(R, ownFile.id);
    ok("  one WhatsApp no longer has says so", !gone.ok && gone.status === 502 && /no longer/.test(gone.error));

    section("Like a person: blue ticks, typing, seen");
    await db.inboxChannel.create({ data: { kind: "WHATSAPP", name: `${TAG} bot wa`, phoneNumberId: PHONE_IDS[4], settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false, bot: { ...bot.bot, on: true } } as object, createdById: admin.id } });
    const readsBefore = reads.length;
    const sentBeforeBot = sent.length;
    const askId = `wamid.zzask${Date.now()}`;
    await server.receiveWhatsApp({ phoneNumberId: PHONE_IDS[4], from: "919900000920", profileName: "Zzprobe Asker", id: askId, at: new Date(), text: "What does it cost?" });
    const botTexts = sent.slice(sentBeforeBot).map((m) => ("text" in m ? m.text : ""));
    ok("on WhatsApp the bot reads the message (blue ticks) and shows 'typing…' before each reply", reads.slice(readsBefore).length === botTexts.length && reads.slice(readsBefore).every((r) => r.messageId === askId && r.typing) && botTexts.includes("PRICE"), botTexts.join(" / "));
    ok("  greeting, answer, check-in — three short messages, as a person sends them", botTexts.length === 3 && botTexts[0] === bot.greeting && botTexts[1] === "PRICE");

    const readsBeforeOpen = reads.length;
    await server.conversationDetail(A, (await db.conversation.findFirstOrThrow({ where: { channelId: shared.id, waId: "919900000902" } })).id);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const knownLast = await db.conversationMessage.findFirstOrThrow({ where: { conversation: { channelId: shared.id, waId: "919900000902" }, author: "CUSTOMER" }, orderBy: { createdAt: "desc" } });
    ok("a WhatsApp conversation opened by the team: the customer's message marked read — their blue ticks", reads.slice(readsBeforeOpen).some((r) => r.messageId === knownLast.externalId && !r.typing) && knownLast.delivery === "READ");
    const readsBeforeAgain = reads.length;
    await server.conversationDetail(A, knownLast.conversationId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    ok("  once — opening it again tells Meta nothing new", reads.length === readsBeforeAgain);

    const visitorConv = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } });
    ok("before anybody types, the bubble shows no 'typing…'", (await server.webPresence(webChannel.id, first.token))?.typing === null);
    const typed = await server.staffTyping(A, visitorConv.id);
    ok("a staff member typing: the bubble shows '<first name> is typing…'", typed.ok && (await server.webPresence(webChannel.id, first.token))?.typing === "Zzprobe");
    ok("  for a few seconds, then not", server.typingIn(visitorConv.id, Date.now() + 7_000) === null);
    await server.receiveWebMessage(webChannel, { token: first.token, text: "Are you still there?" });
    ok("a new message the team hasn't read isn't 'Seen'", (await server.webPresence(webChannel.id, first.token))?.seen === false);
    await server.conversationDetail(A, visitorConv.id);
    ok("  once somebody opens it, it is", (await server.webPresence(webChannel.id, first.token))?.seen === true);
    const readsBeforeWaTyping = reads.length;
    await server.staffTyping(A, knownLast.conversationId);
    await server.staffTyping(A, knownLast.conversationId);
    ok("typing in a WhatsApp conversation shows 'typing…' on their phone — asked of Meta once, not every keystroke", reads.slice(readsBeforeWaTyping).length === 1 && reads[reads.length - 1]!.typing);
    ok("someone who can't see a conversation can't type in it", !(await server.staffTyping(A, ownConv.id)).ok);

    section("Response times: the report");
    const handed = await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId }, select: { needsPersonAt: true, createdAt: true } });
    const awayStart = await db.conversation.findUniqueOrThrow({ where: { id: awayConv.id }, select: { needsPersonAt: true, createdAt: true } });
    ok("the clock starts when the bot hands over — or, without a bot, at the first message", !!handed.needsPersonAt && handed.needsPersonAt > handed.createdAt && !!awayStart.needsPersonAt && Math.abs(awayStart.needsPersonAt.getTime() - awayStart.createdAt.getTime()) < 5_000);
    const sharedReport = await reportLib.inboxReport(M, { days: 7, channelId: shared.id });
    ok("a channel's report: its conversations, the ones answered, a first response time", sharedReport.totals.started >= 2 && sharedReport.totals.answered >= 1 && sharedReport.totals.firstResponse.median !== null && sharedReport.byChannel.length === 1 && sharedReport.byChannel[0].id === shared.id);
    ok("  who answered, for somebody who sees every conversation", sharedReport.byPerson?.some((p) => p.id === agent.id && p.firstResponses >= 1 && p.replies >= 1) === true);
    const agentReport = await reportLib.inboxReport(A, { days: 7, channelId: shared.id });
    ok("  and not for anybody else", agentReport.byPerson === null);
    ok("a rep's own number: in management's figures, not a colleague's", (await reportLib.inboxReport(M, { days: 7, channelId: own.id })).totals.started >= 1 && (await reportLib.inboxReport(A, { days: 7, channelId: own.id })).totals.started === 0);
    const aiReport = await reportLib.inboxReport(M, { days: 7, channelId: aiChannel.id });
    ok("a conversation the bot still has counts as handled by the bot alone", aiReport.totals.botOnly === 1 && aiReport.totals.neededPerson === 0);
    ok("waiting for a person now: open, needing one, nobody's replied", (await reportLib.inboxReport(M, { days: 7, channelId: awayChannel.id })).totals.waitingNow === 1);
    ok("a day for each day of the period", sharedReport.byDay.length === 7 && sharedReport.byDay.reduce((n, d) => n + d.started, 0) === sharedReport.totals.started);

    section("The pages, as the server draws them");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const InboxPage = (require("../src/app/(dashboard)/inbox/page") as { default: Page }).default;
    const SettingsPage = (require("../src/app/(dashboard)/settings/inbox/page") as { default: Page }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const visitorRef = conversationRef((await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).seq);
    actorId = agent.id;
    const inboxHtml = await render(InboxPage, { c: visitorRef });
    ok("the inbox: the conversation asked for, with its messages and who the customer is", inboxHtml.includes("Zzprobe Visitor") && inboxHtml.includes("How much does it cost?") && inboxHtml.includes(visitorRef), inboxHtml.length);
    ok("  and the actions this person may take", inboxHtml.includes("Close") || inboxHtml.includes("Reopen"));
    ok("  the settings aren't theirs: not found", (await thrown(() => render(SettingsPage))) === "notFound");
    actorId = outsider.id;
    ok("somebody without the inbox gets not found", (await thrown(() => render(InboxPage))) === "notFound");
    actorId = admin.id;
    const settingsHtml = await render(SettingsPage);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ReportsPage = (require("../src/app/(dashboard)/inbox/reports/page") as { default: Page }).default;
    actorId = manager.id;
    const reportHtml = await render(ReportsPage, { days: "7" });
    ok("the reports page: the figures, day by day, by channel and by person", reportHtml.includes("Inbox reports") && reportHtml.includes("First response (median)") && reportHtml.includes("By channel") && reportHtml.includes("By person"));
    actorId = agent.id;
    ok("  without who answered what for somebody who doesn't see every conversation", !(await render(ReportsPage, {})).includes("By person"));
    actorId = admin.id;
    ok("the settings: each channel, the website snippet, the webhook to give Meta, and no secret", settingsHtml.includes(`${TAG} site`) && settingsHtml.includes("/api/inbox/public/widget.js") && settingsHtml.includes("/api/inbox/public/whatsapp") && settingsHtml.includes("Verify token") && !/whatsappTokenCipher|whatsappAppSecretCipher/.test(settingsHtml));

    section("Unread, and the actions");
    ok("unread: the conversations waiting on this person", typeof (await server.unreadCount(A)) === "number");
    actorId = outsider.id;
    ok("somebody without the inbox lists nothing and can't reply", (await actions.inboxList({ view: "open" })).length === 0 && !(await actions.inboxReply(first.conversationId, "hi")).ok);
    actorId = agent.id;
    ok("an agent lists it through the action", (await actions.inboxList({ view: "open" })).some((r) => r.id === first.conversationId));
    ok("  and opens it by its reference", (await actions.inboxConversation(conversationRef((await db.conversation.findUniqueOrThrow({ where: { id: first.conversationId } })).seq)))?.id === first.conversationId);
    viewingAs = true;
    const asSomebody = await actions.inboxReply(first.conversationId, "hi");
    ok("nothing changes while viewing as somebody", !asSomebody.ok && /viewing as/.test(asSomebody.error));
    viewingAs = false;
    unsubscribe();
  } finally {
    whatsapp.setTestWhatsAppSender(null);
    whatsapp.setTestWhatsAppMedia(null);
    whatsapp.setTestWhatsAppRead(null);
    server.setInboxPacing(true);
    aiLib.setTestInboxAi(null);
    await cleanup();
    ok("everything named for this check is gone", (await db.inboxChannel.count({ where: { name: { startsWith: TAG } } })) === 0 && (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) failed.` : "\nAll customer inbox checks passed.");
    process.exit(failures ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    await cleanup().catch(() => {});
    process.exit(1);
  });
