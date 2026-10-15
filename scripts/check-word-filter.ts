/**
 * The word filter (owner, 15 Oct 2026 — src/lib/word-filter, src/actions/word-filter.ts).
 *
 *   · Matching: whole words whatever the case, the usual disguises (f*ck, sh1t, f.u.c.k, fuuuck), a
 *     trailing * for endings, Hindi in Devanagari with or without its nukta — and never part of another
 *     word (class, Scunthorpe, cocktail, shiitake, fire retardant).
 *   · The preset, the workspace's own words, and preset words let through; the list cleaned when saved.
 *   · Chat: a message, an edit or a group's name with a filtered word isn't sent; off, it is.
 *   · Tickets: a new ticket, a comment and an email reply refused; a customer's email let in with stars.
 *   · Only whoever may change the settings changes them.
 *
 * Everything is named ZZPROBE_WF and removed in a finally; the workspace's own filters are put back.
 *
 *   npm run check:word-filter
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";
import { cleanWordList, compileWordFilter, WORD_LIST_MAX } from "../src/lib/word-filter/match";
import { PRESET_WORDS } from "../src/lib/word-filter/preset";

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zzprobe Wf", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_WF";
const MAIL = "@zzprobe-wf.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const companyIds = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.supportEmail.deleteMany({ where: { messageId: { startsWith: "<zzprobe-wf" } } });
  if (companyIds.length) await db.ticket.deleteMany({ where: { companyId: { in: companyIds } } });
  if (ids.length) {
    await db.chat.deleteMany({ where: { members: { some: { userId: { in: ids } } } } });
    await db.chatPresence.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  }
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  if (ids.length) await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  section("Matching, without a database");

  const preset = compileWordFilter(PRESET_WORDS);
  const caught = (text: string) => preset.find(text).length > 0;
  for (const text of ["fuck", "FUCK you", "f*ck", "f**k", "fuuuuck", "f.u.c.k", "f u c k", "fucking hell", "sh1t", "$hit", "a$$", "you bitch!", "chutiya", "CHUTIYAA", "bhenchod", "behenchod", "madarchod", "bsdk"]) {
    ok(`catches "${text}"`, caught(text), JSON.stringify(preset.find(text)));
  }
  ok("catches Devanagari as written", caught("तू चूतिया है") && caught("भोसड़ी"));
  ok("  with or without its nukta or chandrabindu", caught("भोसडी") && caught("गांड") && caught("गाँड"));
  for (const text of ["class", "assess the passage", "Scunthorpe", "a cocktail in the cockpit", "shiitake", "fire retardant", "niggardly", "Randip Singh", "chod do yaar", "Kamini from accounts", "Dick Smith", "Hello, how are you?", "assassin", "Bass guitar", "therapist"]) {
    ok(`leaves "${text}" alone`, !caught(text), JSON.stringify(preset.find(text)));
  }
  ok("names the words as they were typed", preset.find("You F*CK and sh1t").join("|") === "F*CK|sh1t", preset.find("You F*CK and sh1t").join("|"));
  ok("turns them into stars, the rest as it was", preset.mask("You f*ck, this is shit!") === "You ****, this is ****!", preset.mask("You f*ck, this is shit!"));
  ok("  Devanagari by its characters", preset.mask("तू चूतिया है") === "तू ****** है", preset.mask("तू चूतिया है"));
  const own = compileWordFilter(["project falcon", "zorb*"]);
  ok("a workspace's own phrase, however it's spaced", own.find("about Project   Falcon today").length === 1 && own.find("project-falcon").length === 1);
  ok("  and a word with its endings", own.find("zorbing").length === 1 && own.find("zorb").length === 1 && own.find("azorb").length === 0);
  const letThrough = compileWordFilter(PRESET_WORDS, ["randi"]);
  ok("a preset word let through goes through", caught("Hi Randi") && letThrough.find("Hi Randi").length === 0 && letThrough.find("you chutiya").length === 1);
  const cleaned = cleanWordList(["  alpha \n beta, Alpha", "", "gamma  delta"]);
  ok("a typed list is trimmed, split and de-duplicated", cleaned.ok && cleaned.words.join("|") === "alpha|beta|gamma delta", JSON.stringify(cleaned));
  ok("  a word without letters is refused", !cleanWordList(["12345"]).ok);
  ok("  and a list past the limit", !cleanWordList(Array.from({ length: WORD_LIST_MAX + 1 }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}${i}`)).ok);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const filterActions = require("../src/actions/word-filter") as typeof import("../src/actions/word-filter");
  const server = require("../src/lib/word-filter/server") as typeof import("../src/lib/word-filter/server");
  const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
  const tickets = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const supportMail = require("../src/actions/support-mail") as typeof import("../src/actions/support-mail");
  const { receiveEmail } = require("../src/lib/support-mail/receive") as typeof import("../src/lib/support-mail/receive");

  const before = await db.wordFilter.findMany();
  await cleanup();
  try {
    const make = async (key: string, role: "ADMIN" | "PROFILE") => {
      const u = await db.user.create({ data: { name: `Zzprobe ${key}`, email: `${key}${MAIL}`, role, passwordHash: "x".repeat(60) } });
      roles.set(u.id, role);
      return u;
    };
    const admin = await make("admin", "ADMIN");
    const alice = await make("alice", "PROFILE");
    const bob = await make("bob", "PROFILE");
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id, relationshipType: "CLIENT" },
    });
    const as = (u: { id: string }) => {
      actorId = u.id;
    };
    const send = (chatId: string, body: string) => {
      const form = new FormData();
      form.set("chatId", chatId);
      form.set("body", body);
      return chat.sendChatMessage(form);
    };
    const save = (area: "CHAT" | "TICKETS", input: Partial<{ enabled: boolean; usePreset: boolean; words: string[]; allowed: string[] }>) =>
      filterActions.saveWordFilter(area, { enabled: true, usePreset: true, words: [], allowed: [], ...input });

    section("Settings");

    await db.wordFilter.deleteMany({ where: { area: { in: ["CHAT", "TICKETS"] } } });
    ok("with nothing saved, each area is off", !(await server.wordFilterSettings("CHAT")).enabled && !(await server.wordFilterSettings("TICKETS")).enabled);
    as(alice);
    ok("somebody who can't change settings can't change the filter", !(await save("CHAT", {})).ok);
    as(admin);
    const saved = await save("CHAT", { words: ["Project Falcon", "project falcon", "zorb*"], allowed: ["randi"] });
    ok("an admin saves it, the list cleaned", saved.ok && saved.data.words.join("|") === "Project Falcon|zorb*", saved.ok ? saved.data.words.join("|") : saved.error);
    ok("  recorded without the words themselves", (await db.auditLog.count({ where: { userId: admin.id, entityType: "WordFilter", entityLabel: { contains: "2 own word(s)" } } })) === 1);
    ok("an area that isn't one is refused", !(await filterActions.saveWordFilter("ELSEWHERE" as "CHAT", { enabled: true, usePreset: true, words: [], allowed: [] })).ok);
    const { WordFilterForm } = require("../src/components/settings/word-filter-form") as typeof import("../src/components/settings/word-filter-form");
    const form = (area: "CHAT" | "TICKETS") =>
      renderToStaticMarkup(createElement(WordFilterForm, { area, initial: { enabled: true, usePreset: true, words: ["zorb*"], allowed: [] } })).replace(/&#x27;/g, "'");
    const chatForm = form("CHAT");
    ok("the page offers the switch, the preset and its words, your own words and a try-it box", ["Keep these words out of chat", "Use Deskzo's preset", "See the preset's words", "chutiya*", "Your own words", "Let these preset words through", "Try a message"].every((t) => chatForm.includes(t)));
    ok("  with what is saved filled in", chatForm.includes("zorb*") && /type="checkbox"[^>]*checked/.test(chatForm));
    ok("  and for tickets, says a customer's email gets stars", form("TICKETS").includes("with the words shown as stars"));

    section("Chat");

    as(alice);
    const started = await chat.startDirectChat(bob.id);
    const chatId = started.ok ? started.data.chatId : "";
    const countMessages = () => db.chatMessage.count({ where: { chatId, kind: "TEXT" } });
    const sentBefore = await countMessages();
    const refused = await send(chatId, "you f*ck, stop it");
    ok("a message with a filtered word isn't sent", !refused.ok && (await countMessages()) === sentBefore, refused.ok ? "sent" : refused.error);
    ok("  the sender is told which words", !refused.ok && refused.error.includes('"f*ck"'), refused.ok ? "" : refused.error);
    ok("  the workspace's own phrase too", !(await send(chatId, "the PROJECT falcon numbers")).ok);
    ok("  a preset word let through goes", (await send(chatId, "Thanks, Randi")).ok);
    const clean = await send(chatId, "All good here");
    ok("a clean message goes", clean.ok);
    const edited = clean.ok ? await chat.editChatMessage(clean.data.id, "All good here, sh1t") : null;
    ok("an edit that adds one is refused", !!edited && !edited.ok, edited?.ok ? "edited" : edited?.error);
    ok("  and the message keeps its words", clean.ok && (await db.chatMessage.findUniqueOrThrow({ where: { id: clean.data.id }, select: { body: true } })).body === "All good here");
    const group = await chat.createGroupChat({ name: "Bhenchod squad", memberIds: [bob.id] });
    ok("a group named with one isn't made", !group.ok, group.ok ? "made" : group.error);
    as(admin);
    await save("CHAT", { enabled: false });
    as(alice);
    ok("with the filter off, the same message goes", (await send(chatId, "you f*ck, stop it")).ok);

    section("Tickets");

    as(admin);
    await save("TICKETS", {});
    const ticket = await tickets.createTicket({ companyId: company.id, title: "This bastard printer", description: "", priority: "MEDIUM" });
    ok("a new ticket with a filtered word isn't saved", !ticket.ok && ticket.error.includes("bastard"), ticket.ok ? "saved" : ticket.error);
    const fine = await tickets.createTicket({ companyId: company.id, title: "The printer jams", description: "Since Monday", priority: "MEDIUM" });
    ok("a clean one is", fine.ok, fine.ok ? "" : fine.error);
    const ticketId = fine.ok ? fine.data.id : "";
    const comment = await tickets.addTicketComment({ ticketId, body: "Customer is a chutiya" });
    ok("  a comment with one isn't", !comment.ok && (await db.ticketComment.count({ where: { ticketId } })) === 0, comment.ok ? "saved" : comment.error);
    const reply = await supportMail.replyToTicketByEmail({ ticketId, body: "Read the manual, you idiot bastard" });
    ok("  nor an email reply", !reply.ok && reply.error.includes("bastard"), reply.ok ? "sent" : reply.error);

    // A customer's email: kept with the words as stars. An automatic reply is the path with no ticket,
    // acknowledgement or notification to tidy — what is stored is the same base as any other.
    const received = await receiveEmail({
      from: { address: `customer${MAIL}`, name: null },
      to: [],
      cc: [],
      subject: "Your shit service",
      text: "Fix it, you chutiya.",
      messageId: "<zzprobe-wf-1@test>",
      inReplyTo: null,
      references: [],
      automated: "An automatic reply",
      attachments: [],
    });
    const stored = received.emailId ? await db.supportEmail.findUnique({ where: { id: received.emailId }, select: { subject: true, body: true } }) : null;
    ok("a customer's email is kept with the words as stars", stored?.subject === "Your **** service" && stored.body === "Fix it, you *******.", JSON.stringify(stored));
  } finally {
    await db.wordFilter.deleteMany({ where: { area: { in: ["CHAT", "TICKETS"] } } });
    for (const row of before) await db.wordFilter.create({ data: row });
    await cleanup();
  }

  console.log(failures === 0 ? "\nAll word filter checks passed." : `\n${failures} word filter check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
