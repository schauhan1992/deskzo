/**
 * Team chat (src/lib/chat, src/actions/chat.ts).
 *
 *   · The rules without a database: one direct chat per pair, the ticks, previews, record links,
 *     @mentions, the files chat takes, the retention choices.
 *   · Only a chat's members read it; one who left keeps what was said up to then and nothing after;
 *     nobody else — and nobody viewing as somebody — gets in.
 *   · Sending, editing and deleting for everyone, with their windows; files kept and refused.
 *   · Unread counts, muting, @mentions told without their text, delivery and read ticks, the live bus.
 *   · Groups: admins, adding, removing, leaving, and never left without an admin.
 *   · Search, the files route, the export refused to anybody but the super admin, nightly retention.
 *
 * Everything is named ZZPROBE_CHAT and removed in a finally.
 *
 *   npm run check:chat
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  chatFileType,
  directKeyFor,
  isRetentionChoice,
  mentionsIn,
  previewOf,
  readBy,
  recordLinksIn,
  tickFor,
  type ReceiptMember,
} from "../src/lib/chat/rules";

let actorId = "";
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actorId ? { id: actorId, role: "PROFILE", name: names.get(actorId) ?? "Zzprobe", email: `${actorId}${MAIL}` } : null);
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
const TAG = "ZZPROBE_CHAT";
const MAIL = "@zzprobe-chat.invalid";
const names = new Map<string, string>();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

/** A one-pixel PNG, as a browser would upload it. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function cleanup() {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.chat.deleteMany({ where: { members: { some: { userId: { in: ids } } } } });
    await db.chatPresence.deleteMany({ where: { userId: { in: ids } } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
}

async function main() {
  section("The rules, without a database");

  ok("one direct chat per pair, whoever starts it", directKeyFor("b", "a") === directKeyFor("a", "b") && directKeyFor("a", "b") === "a|b");
  const sentAt = "2026-10-15T10:00:00.000Z";
  const member = (userId: string, over: Partial<ReceiptMember> = {}): ReceiptMember => ({
    userId,
    joinedAt: "2026-10-01T00:00:00.000Z",
    leftAt: null,
    lastDeliveredAt: null,
    lastReadAt: null,
    ...over,
  });
  const msg = { senderId: "a", createdAt: sentAt };
  ok("one tick until it reaches them", tickFor(msg, [member("a"), member("b")]) === "sent");
  ok("two grey ticks once delivered", tickFor(msg, [member("a"), member("b", { lastDeliveredAt: "2026-10-15T10:00:01.000Z" })]) === "delivered");
  ok("blue once read", tickFor(msg, [member("a"), member("b", { lastReadAt: "2026-10-15T10:05:00.000Z" })]) === "read");
  ok(
    "a group's is read only when everybody has read it",
    tickFor(msg, [member("a"), member("b", { lastReadAt: "2026-10-15T10:05:00.000Z" }), member("c", { lastDeliveredAt: "2026-10-15T10:01:00.000Z" })]) === "delivered",
  );
  ok(
    "  somebody who joined afterwards doesn't hold it back",
    tickFor(msg, [member("a"), member("b", { lastReadAt: "2026-10-15T10:05:00.000Z" }), member("c", { joinedAt: "2026-10-15T11:00:00.000Z" })]) === "read",
  );
  ok("  nor somebody who had left", tickFor(msg, [member("a"), member("b", { lastReadAt: sentAt }), member("c", { leftAt: "2026-10-14T00:00:00.000Z" })]) === "read");
  ok("read by: the members who have read it", readBy(msg, [member("a"), member("b", { lastReadAt: sentAt }), member("c")]).join() === "b");
  ok("a preview is the newest line, sender first in a group", previewOf({ kind: "TEXT", body: "Hello  there", deletedAt: null, attachmentCount: 0, senderName: "Priya Sharma" }, { group: true, mine: false }) === "Priya: Hello there");
  ok("  yours says You", previewOf({ kind: "TEXT", body: "Hi", deletedAt: null, attachmentCount: 0, senderName: "Me" }, { group: false, mine: true }) === "You: Hi");
  ok("  a file alone says so", previewOf({ kind: "TEXT", body: "", deletedAt: null, attachmentCount: 2, senderName: null }, { group: false, mine: false }) === "2 files");
  ok("  and a deleted one never shows its text", previewOf({ kind: "TEXT", body: "secret", deletedAt: sentAt, attachmentCount: 0, senderName: null }, { group: false, mine: false }) === "This message was deleted");
  const links = recordLinksIn("See https://acme.deskzo.com/companies/C-0042, and /leads/L-0007 and /companies/C-0042 again. Not /items/I-1.");
  ok("record links are found, once each, bare or with the host", links.map((l) => l.path).join(" ") === "/companies/C-0042 /leads/L-0007", JSON.stringify(links));
  const people = [
    { id: "p1", name: "Priya" },
    { id: "p2", name: "Priya Sharma" },
    { id: "r", name: "Ravi Kumar" },
  ];
  ok("@mentions name the longest match", mentionsIn("Thanks @Priya Sharma and @ravi kumar", people).sort().join() === "p2,r");
  ok("  and the shorter name only when it is there on its own", mentionsIn("@Priya Sharma, cc @Priya", people).sort().join() === "p1,p2");
  ok("pictures, PDFs and office files are taken", ["a.png|image/png", "b.pdf|application/pdf", "c.xlsx|application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].every((s) => chatFileType(s.split("|")[1]!, s.split("|")[0]!)));
  ok("  a type the browser didn't name is read from the extension", chatFileType("", "notes.txt") === "text/plain");
  ok("  web pages, SVG and programs are not", !chatFileType("text/html", "x.html") && !chatFileType("image/svg+xml", "x.svg") && !chatFileType("application/octet-stream", "x.exe"));
  ok("  nor a picture that is really something else", !chatFileType("image/png", "x.html"));
  ok("retention: forever, 90 days, a year, three years — nothing else", [null, 90, 365, 1095].every(isRetentionChoice) && !isRetentionChoice(30));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
  const admin = require("../src/actions/chat-admin") as typeof import("../src/actions/chat-admin");
  const server = require("../src/lib/chat/server") as typeof import("../src/lib/chat/server");
  const bus = require("../src/lib/chat/bus") as typeof import("../src/lib/chat/bus");
  const retention = require("../src/lib/chat/retention") as typeof import("../src/lib/chat/retention");
  const { tenantKey } = require("../src/lib/tenancy/cache") as typeof import("../src/lib/tenancy/cache");
  const filesRoute = require("../src/app/api/chat/files/[id]/route") as typeof import("../src/app/api/chat/files/[id]/route");
  const exportRoute = require("../src/app/api/chat/export/[id]/route") as typeof import("../src/app/api/chat/export/[id]/route");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");

  const settingsBefore = await db.chatSettings.findUnique({ where: { id: "global" } });
  const today = (await workspaceClock()).calendarDate(new Date());
  const retentionRunBefore = await db.dailyJobRun.findUnique({ where: { job_day: { job: "chat-retention", day: today } } });

  await cleanup();
  try {
    const make = async (key: string, name: string, active = true) => {
      const u = await db.user.create({ data: { name: `Zzprobe ${name}`, email: `${key}${MAIL}`, role: "PROFILE", passwordHash: "x".repeat(60), active } });
      names.set(u.id, u.name);
      return u;
    };
    const alice = await make("alice", "Alice Chat");
    const bob = await make("bob", "Bob Chat");
    const carol = await make("carol", "Carol Chat");
    const dave = await make("dave", "Dave Gone", false);
    const as = (u: { id: string }) => {
      actorId = u.id;
    };
    const send = async (chatId: string, body: string, extra: (form: FormData) => void = () => {}) => {
      const form = new FormData();
      form.set("chatId", chatId);
      form.set("body", body);
      extra(form);
      return chat.sendChatMessage(form);
    };

    section("One to one");

    as(alice);
    const started = await chat.startDirectChat(bob.id);
    ok("Alice starts a chat with Bob", started.ok);
    const directId = started.ok ? started.data.chatId : "";
    as(bob);
    const again = await chat.startDirectChat(alice.id);
    ok("  Bob starting one with Alice opens the same chat", again.ok && again.data.chatId === directId);
    ok("  which Bob doesn't see listed while nothing has been said", !(await chat.listChatSummaries()).some((c) => c.id === directId));
    const deadEnd = await chat.startDirectChat(dave.id);
    ok("nobody starts a new chat with a switched-off account", !deadEnd.ok);

    const tenantId = await tenantKey();
    const heard: string[] = [];
    const stop = bus.subscribe(tenantId, bob.id, (e) => heard.push(e.type));
    as(alice);
    const first = await send(directId, "Hello Bob — the quote for /companies/C-999999 is ready");
    ok("Alice sends", first.ok, first.ok ? "" : first.error);
    ok("  Bob's open window hears it at once", heard.includes("message"), heard.join(","));
    ok("  and, open, it reaches him: a delivery tick for Alice", heard.includes("receipt"));
    stop();
    as(bob);
    const listed = (await chat.listChatSummaries()).find((c) => c.id === directId);
    ok("  now it is in Bob's list, unread, under Alice's name", listed?.unread === 1 && listed.title === "Zzprobe Alice Chat", JSON.stringify(listed));
    ok("  and counts on his chat button", (await chat.chatUnreadCount()) === 1);
    await chat.markChatRead(directId);
    ok("Bob reads it: his count drops", (await chat.chatUnreadCount()) === 0);
    const opened = await chat.openChat(directId);
    const firstMsg = opened?.messages.find((m) => first.ok && m.id === first.data.id);
    ok("  and Alice's message shows two blue ticks", !!firstMsg && tickFor(firstMsg, opened!.members) === "read");

    as(carol);
    ok("Carol, not in it, can't open it", (await chat.openChat(directId)) === null);
    ok("  nor send to it", !(await send(directId, "hi")).ok);
    ok("  nor find what was said in it", (await chat.searchChatMessages("quote for")).length === 0);
    as(bob);
    ok("Bob finds it by what was said", (await chat.searchChatMessages("QUOTE for")).some((h) => h.chatId === directId));
    const cards = await chat.resolveChatRecordLinks(["/companies/C-999999", "/items/I-1"]);
    ok("a record link that isn't a record Bob can open is a closed card, and other paths are ignored", cards.length === 1 && !cards[0]!.allowed && cards[0]!.title === null, JSON.stringify(cards));

    viewingAs = true;
    ok("nobody viewing as somebody can read their chats", await chat.openChat(directId).then(() => false, () => true));
    ok("  or send as them", !(await send(directId, "as Bob")).ok);
    viewingAs = false;

    section("The live stream");

    {
      const streamRoute = require("../src/app/api/chat/stream/route") as typeof import("../src/app/api/chat/stream/route");
      as(bob);
      const abort = new AbortController();
      const res = await streamRoute.GET(new Request("http://x/api/chat/stream", { signal: abort.signal, headers: { "sec-fetch-site": "same-origin" } }));
      ok("Bob's window opens a stream of events", res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("text/event-stream"), res.status);
      ok("  that no proxy is allowed to hold back", (res.headers.get("cache-control") ?? "").includes("no-transform"));
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      const readUntil = async (needle: string) => {
        const deadline = Date.now() + 3000;
        while (!text.includes(needle) && Date.now() < deadline) {
          const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), 250))]);
          if (chunk && !chunk.done) text += decoder.decode(chunk.value);
        }
        return text.includes(needle);
      };
      ok("  it starts by saying who is online", await readUntil(`"type":"ready"`));
      as(alice);
      await send(directId, "Over the wire");
      ok("  and carries Alice's next message as it is sent", await readUntil("Over the wire"));
      as(bob);
      await chat.markChatRead(directId);
      abort.abort();
      await new Promise((r) => setTimeout(r, 50));
      ok("closing the window leaves Bob offline, with a last seen", !bus.isListening(tenantId, bob.id) && !!(await db.chatPresence.findUnique({ where: { userId: bob.id } })));
      const elsewhere = await streamRoute.GET(new Request("http://x/api/chat/stream", { headers: { "sec-fetch-site": "cross-site" } }));
      ok("another site's page can't open one", elsewhere.status === 403);
      viewingAs = true;
      ok("  nor can anybody viewing as somebody", (await streamRoute.GET(new Request("http://x/api/chat/stream"))).status === 403);
      viewingAs = false;
      actorId = "";
      ok("  nor anybody signed out", (await streamRoute.GET(new Request("http://x/api/chat/stream"))).status === 401);
    }

    section("Editing, deleting, files");

    as(bob);
    if (first.ok) {
      ok("Bob can't edit Alice's message", !(await chat.editChatMessage(first.data.id, "changed")).ok);
      ok("  nor delete it", !(await chat.deleteChatMessage(first.data.id)).ok);
    }
    as(alice);
    if (first.ok) {
      const edited = await chat.editChatMessage(first.data.id, "Hello Bob — the quote is ready");
      ok("Alice edits hers", edited.ok && edited.data.editedAt !== null && edited.data.body.endsWith("ready"));
      await db.chatMessage.update({ where: { id: first.data.id }, data: { createdAt: new Date(Date.now() - EDIT_WINDOW_MS - 1000) } });
      ok("  not after fifteen minutes", !(await chat.editChatMessage(first.data.id, "too late")).ok);
    }
    const withFile = await send(directId, "", (form) => form.append("files", new File([PNG], "pixel.png", { type: "image/png" })));
    ok("a picture on its own is a message", withFile.ok && withFile.data.attachments.length === 1 && withFile.data.attachments[0]!.size === PNG.length);
    const refused = await send(directId, "page", (form) => form.append("files", new File(["<script>"], "evil.html", { type: "text/html" })));
    ok("  a web page isn't taken", !refused.ok);
    const tooBig = await send(directId, "", (form) => form.append("files", new File([Buffer.alloc(5 * 1024 * 1024 + 1)], "big.pdf", { type: "application/pdf" })));
    ok("  nor more than 5 MB", !tooBig.ok);

    const fileId = withFile.ok ? withFile.data.attachments[0]!.id : "";
    const fetchFile = (query = "") => filesRoute.GET(new Request(`http://x/api/chat/files/${fileId}${query}`), { params: Promise.resolve({ id: fileId }) });
    as(bob);
    const got = await fetchFile();
    ok("Bob opens the picture", got.status === 200 && got.headers.get("content-type") === "image/png" && Buffer.from(await got.arrayBuffer()).equals(PNG));
    ok("  and may save it", (await fetchFile("?download=1")).headers.get("content-disposition")?.startsWith("attachment") === true);
    await db.chatSettings.upsert({ where: { id: "global" }, create: { id: "global", attachmentsViewOnly: true }, update: { attachmentsViewOnly: true } });
    ok("with files view-only, it still opens", (await fetchFile()).status === 200);
    ok("  but isn't offered as a download", (await fetchFile("?download=1")).status === 403);
    await db.chatSettings.update({ where: { id: "global" }, data: { attachmentsViewOnly: false } });
    as(carol);
    ok("Carol can't fetch it at all", (await fetchFile()).status === 404);

    as(alice);
    if (withFile.ok) {
      const gone = await chat.deleteChatMessage(withFile.data.id);
      ok("Alice deletes it for everyone", gone.ok && gone.data.deletedAt !== null && gone.data.attachments.length === 0);
      ok("  its file goes with it", (await db.chatAttachment.count({ where: { messageId: withFile.data.id } })) === 0);
      const late = await send(directId, "a minute");
      if (late.ok) {
        await db.chatMessage.update({ where: { id: late.data.id }, data: { createdAt: new Date(Date.now() - DELETE_WINDOW_MS - 1000) } });
        ok("  but not one sent over an hour ago", !(await chat.deleteChatMessage(late.data.id)).ok);
      }
    }

    section("Groups");

    as(alice);
    const created = await chat.createGroupChat({ name: `${TAG} Sales`, memberIds: [bob.id, carol.id, dave.id] });
    ok("Alice makes a group with Bob and Carol", created.ok);
    const groupId = created.ok ? created.data.chatId : "";
    const roster = await server.membersView(groupId);
    ok("  a switched-off colleague isn't added", roster.length === 3 && !roster.some((m) => m.userId === dave.id));
    ok("  and Alice is its admin", roster.find((m) => m.userId === alice.id)?.isAdmin === true && !roster.find((m) => m.userId === bob.id)?.isAdmin);

    as(bob);
    ok("Bob, not an admin, can't rename it", !(await chat.renameGroupChat(groupId, "Mine")).ok);
    await chat.muteChat(groupId, 8);
    as(alice);
    await send(groupId, "Morning all");
    as(bob);
    ok("Bob muted it: plain messages don't count", (await chat.chatUnreadCount()) === 0);
    as(alice);
    const mention = await send(groupId, "@Zzprobe Bob Chat can you call them? It's about the discount");
    ok("an @mention names Bob", mention.ok && mention.data.mentionIds.includes(bob.id) && !mention.data.mentionIds.includes(carol.id));
    as(bob);
    ok("  and counts for him even muted", (await chat.chatUnreadCount()) === 1);
    const told = await db.notification.findFirst({ where: { userId: bob.id, type: "CHAT_MENTION" } });
    ok("  he is told who and where", !!told && told.title.includes("Alice Chat") && told.title.includes("Sales"), told?.title);
    ok("  never what", !!told && !`${told.title} ${told.message ?? ""}`.includes("discount"));

    as(carol);
    const left = await chat.leaveGroupChat(groupId);
    ok("Carol leaves", left.ok);
    as(alice);
    await send(groupId, "After Carol left");
    as(carol);
    const carolView = await chat.openChat(groupId);
    ok("  she keeps what was said before", !!carolView?.messages.some((m) => m.body === "Morning all"));
    ok("  and sees nothing after", !carolView?.messages.some((m) => m.body === "After Carol left"));
    ok("  and can't send to it", !(await send(groupId, "still here?")).ok);

    as(alice);
    const readded = await chat.addGroupMembers(groupId, [carol.id]);
    ok("Alice adds Carol back", readded.ok);
    as(carol);
    const back = await chat.openChat(groupId);
    ok("  who starts again from now, like a newcomer", !!back && !back.messages.some((m) => m.body === "Morning all"));

    as(alice);
    await chat.leaveGroupChat(groupId);
    const admins = (await server.membersView(groupId)).filter((m) => !m.leftAt && m.isAdmin);
    ok("the last admin leaving hands the group to the longest-standing member", admins.length === 1 && admins[0]!.userId === bob.id, admins.map((a) => a.name).join());

    section("Drawn");

    {
      // The screen itself can't be looked at without signing in, so it is drawn here from real data:
      // a crash in drawing a message, a tick or a file shows up as a failed check rather than a blank page.
      const { createElement } = require("react") as typeof import("react");
      const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
      const { ClockProvider } = require("../src/components/time/clock-provider") as typeof import("../src/components/time/clock-provider");
      const { ChatList } = require("../src/components/chat/chat-list") as typeof import("../src/components/chat/chat-list");
      const { ChatThread } = require("../src/components/chat/chat-thread") as typeof import("../src/components/chat/chat-thread");
      as(alice);
      await send(directId, "Have a look at /companies/C-999999 when you can");
      const boot = await chat.chatBootstrap();
      const thread = await chat.openChat(directId);
      const drawn = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(ClockProvider, { zone: "Asia/Kolkata" }, el));
      let listHtml = "";
      let threadHtml = "";
      try {
        listHtml = drawn(createElement(ChatList, { boot, chats: boot.chats, activeId: directId, typing: {}, onOpen: () => {}, onStarted: () => {} }));
        threadHtml = thread
          ? drawn(
              createElement(ChatThread, {
                boot,
                chat: thread.summary,
                thread: { members: thread.members, messages: thread.messages, hasMore: thread.hasMore, highlight: null },
                typing: [],
                compact: false,
                onBack: () => {},
                onThread: () => {},
                onSent: () => {},
                onLeft: () => {},
              }),
            )
          : "";
      } catch (err) {
        ok("the chat screen draws", false, err instanceof Error ? err.message : err);
      }
      ok("Alice's list draws, with Bob's chat and her group", listHtml.includes("Zzprobe Bob Chat") && listHtml.includes(`${TAG} Sales`));
      ok("the conversation draws its messages", threadHtml.includes("Over the wire") && threadHtml.includes("Have a look at"));
      ok("  with read ticks on Alice's", threadHtml.includes('aria-label="Read"'));
      ok("  the deleted one as deleted", threadHtml.includes("You deleted this message"));
      ok("  and the record link as a link", threadHtml.includes('href="/companies/C-999999"'));
      const { ChatButton } = require("../src/components/chat/chat-button") as typeof import("../src/components/chat/chat-button");
      const viewAsButton = renderToStaticMarkup(createElement(ChatButton));
      ok("viewing as somebody, their chat button still shows — without a count, and saying chats are private", viewAsButton.includes('href="/chat"') && viewAsButton.includes("private") && !viewAsButton.includes("bg-red-600"));
    }

    section("Settings and the export");

    as(bob);
    ok("Bob, without the settings permission, can't change chat's rules", !(await admin.saveChatSettings({ attachmentsViewOnly: true, retentionDays: null })).ok);
    ok("  nor find chats to export", (await admin.findChatsToExport("Zzprobe")).length === 0);
    const exported = await exportRoute.GET(new Request(`http://x/api/chat/export/${groupId}`), { params: Promise.resolve({ id: groupId }) });
    ok("  nor export one — it isn't there for him", exported.status === 404);

    section("Retention");

    const old = await db.chatMessage.create({ data: { chatId: directId, senderId: alice.id, body: `${TAG} ancient`, createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    // Only where nothing but this suite's messages is that old: the purge is workspace-wide.
    const othersThatOld = await db.chatMessage.count({ where: { createdAt: { lt: new Date(Date.now() - 365 * 86_400_000) }, chat: { members: { none: { user: { email: { endsWith: MAIL } } } } } } });
    await db.chatSettings.update({ where: { id: "global" }, data: { retentionDays: 365 } });
    if (!retentionRunBefore && othersThatOld === 0) {
      const run = await retention.purgeExpiredChat();
      ok("messages older than the workspace keeps them are deleted", run.deleted >= 1 && !(await db.chatMessage.findUnique({ where: { id: old.id } })));
      ok("  once a day", (await retention.purgeExpiredChat()).reason === "already ran today");
      ok("  and nothing newer", (await db.chatMessage.count({ where: { chatId: directId } })) > 0);
    } else {
      console.log("  (skipped: today's chat retention already ran here, or real messages are that old)");
    }
  } finally {
    actorId = "";
    viewingAs = false;
    await cleanup();
    if (settingsBefore) await db.chatSettings.update({ where: { id: "global" }, data: { attachmentsViewOnly: settingsBefore.attachmentsViewOnly, retentionDays: settingsBefore.retentionDays } });
    else await db.chatSettings.deleteMany({ where: { id: "global" } });
    if (!retentionRunBefore) await db.dailyJobRun.deleteMany({ where: { job: "chat-retention", day: today } });
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll chat checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
