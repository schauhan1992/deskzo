/**
 * check:app-chat — team chat in the Deskzo app (src/app/api/app/chat, owner 18 Oct 2026) through its real route
 * handlers, two paired phones talking, against this workspace's database.
 *
 *   · The chat list, the people to start one with; a chat of two, the same one however often it's started.
 *   · Sending as a form, with a picture: the other phone's list shows it unread; opening shows it; reading turns the
 *     sender's ticks blue (the member's read position).
 *   · The picture: to a member of the chat, nobody else.
 *   · Replies, reactions, edits and deletes for everyone, pins — by the web's own actions and rules; a stranger's
 *     message can't be touched; the word filter's refusal is the sender's to see.
 *   · The live stream: the other phone hears a new message as it is sent.
 *   · A group: made, its @mention noted, left; muting; searching.
 *
 * Everything is named ZZAPPCHAT and removed at the end.
 *
 *   npm run check:app-chat
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "1";
process.env.DESKZO_APP = "on";

const TAG = "ZZAPPCHAT";
const MAIL = "@zzappchat.invalid";
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:app-chat", "x-forwarded-for": "198.51.100.70" });

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/headers") return { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  if (request === "@/lib/auth") {
    return {
      auth: async () => {
        /* eslint-disable-next-line @typescript-eslint/no-require-imports */
        const { apiActor } = require("../src/lib/api/actor") as typeof import("../src/lib/api/actor");
        const api = apiActor();
        return api ? { user: { id: api.userId, name: api.name, email: api.email, role: api.role }, expires: "" } : null;
      },
      signIn: async () => {},
      signOut: async () => {},
      handlers: {},
    };
  }
  if (request === "@/lib/email") return { sendEmailNotification: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (!ids.length) return;
  const chats = (await db.chatMember.findMany({ where: { userId: { in: ids } }, select: { chatId: true } })).map((m) => m.chatId);
  await db.chat.deleteMany({ where: { id: { in: chats } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

type Answer<T = unknown> = { status: number; data: T; error?: { code: string; message: string } };

/** The route module for a path under /api/app/chat, and its params. */
function routeFor(pathOnly: string): { dir: string; params: Record<string, string> } {
  const parts = pathOnly.replace(/^\/chat\/?/, "").split("/").filter(Boolean);
  const statics = new Set(["summaries", "direct", "groups", "search", "stream"]);
  if (parts.length === 0) return { dir: "chat", params: {} };
  if (parts.length === 1 && statics.has(parts[0]!)) return { dir: `chat/${parts[0]}`, params: {} };
  if (parts[0] === "files") return { dir: "chat/files/[id]", params: { id: parts[1]! } };
  if (parts[0] === "messages") return { dir: `chat/messages/[id]${parts[2] ? `/${parts[2]}` : ""}`, params: { id: parts[1]! } };
  return { dir: `chat/[id]${parts[1] ? `/${parts[1]}` : ""}`, params: { id: parts[0]! } };
}

async function raw(token: string, method: string, pathAndQuery: string, body?: unknown | FormData): Promise<Response> {
  const [pathOnly] = pathAndQuery.split("?");
  const { dir, params } = pathOnly === "/pair" ? { dir: "pair", params: {} } : pathOnly === "/me" ? { dir: "me", params: {} } : routeFor(pathOnly!);
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require(`../src/app/api/app/${dir}/route`) as Record<string, (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>>;
  const handler = mod[method];
  if (!handler) throw new Error(`${dir} has no ${method}`);
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  for (const [k, v] of requestHeaders) headers[k] ??= v;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) headers["content-type"] = "application/json";
  const req = new Request(`http://deskzo.localhost:3000/api/app${pathAndQuery}`, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
  return handler(req, { params: Promise.resolve(params) });
}

async function call<T = unknown>(token: string, method: string, pathAndQuery: string, body?: unknown | FormData): Promise<Answer<T>> {
  const res = await raw(token, method, pathAndQuery, body);
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  return { status: res.status, data: json.data as T, error: json.error };
}

type Summary = { id: string; kind: string; title: string; unread: number; mentioned: boolean; mutedUntil: string | null; left: boolean };
type Message = { id: string; createdAt: string; body: string; senderId: string | null; attachments: { id: string; mimeType: string }[]; replyTo: { id: string } | null; reactions: { emoji: string; userIds: string[] }[]; editedAt: string | null; deletedAt: string | null };
type Opened = { summary: Summary; members: { userId: string; lastReadAt: string | null }[]; messages: Message[]; pins: { messageId: string }[] };

// One white pixel, a real PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pairing = require("../src/lib/app/pairing") as typeof import("../src/lib/app/pairing");
  const { moduleAvailableForTenant } = require("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await cleanup();
  try {
    if (!(await moduleAvailableForTenant("chat"))) {
      ok("Chat is switched on in this workspace — the suite needs it", false);
      return;
    }

    section("Two phones");
    const make = (name: string) => db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const asha = await make("Asha");
    const bilal = await make("Bilal");
    const chetan = await make("Chetan");
    const pair = async (userId: string, model: string) => {
      const code = await pairing.startPairing(userId);
      const res = await call<{ token: string }>("", "POST", "/pair", { code: code.code, platform: "android", model });
      return res.data.token;
    };
    const ashaPhone = await pair(asha.id, `${TAG} Asha's phone`);
    const bilalPhone = await pair(bilal.id, `${TAG} Bilal's phone`);
    const chetanPhone = await pair(chetan.id, `${TAG} Chetan's phone`);
    ok("three colleagues, each phone paired", [ashaPhone, bilalPhone, chetanPhone].every((t) => t?.startsWith("dzp_")));
    const me = await call<{ can: { chat: boolean } }>(ashaPhone, "GET", "/me");
    ok("/me: chat is open to them", me.data.can.chat === true);
    const boot = await call<{ me: { id: string }; people: { id: string }[]; chats: Summary[] }>(ashaPhone, "GET", "/chat");
    ok("the chat list and the people to start one with", boot.status === 200 && boot.data.me.id === asha.id && boot.data.people.some((p) => p.id === bilal.id), boot.status);

    section("A chat of two");
    const started = await call<{ chat_id: string }>(ashaPhone, "POST", "/chat/direct", { user_id: bilal.id });
    const again = await call<{ chat_id: string }>(ashaPhone, "POST", "/chat/direct", { user_id: bilal.id });
    const chatId = started.data.chat_id;
    ok("started with Bilal — the same chat however often", started.status === 200 && !!chatId && again.data.chat_id === chatId, started.status);
    const form = new FormData();
    form.append("body", "Morning! The quote is attached.");
    form.append("files", new File([PNG], "quote.png", { type: "image/png" }));
    const sent = await call<Message>(ashaPhone, "POST", `/chat/${chatId}/messages`, form);
    ok("a message with a picture, sent as a form", sent.status === 201 && sent.data.body === "Morning! The quote is attached." && sent.data.attachments.length === 1, sent.error?.message ?? sent.status);
    const bilalList = await call<Summary[]>(bilalPhone, "GET", "/chat/summaries");
    ok("  on Bilal's list, unread", bilalList.data.some((s) => s.id === chatId && s.unread === 1));
    const opened = await call<Opened>(bilalPhone, "GET", `/chat/${chatId}`);
    ok("  Bilal opens it: the message, the picture", opened.status === 200 && opened.data.messages.some((m) => m.id === sent.data.id && m.attachments[0]?.mimeType === "image/png"));
    const read = await call<{ total: number }>(bilalPhone, "POST", `/chat/${chatId}/read`);
    const ashaView = await call<Opened>(ashaPhone, "GET", `/chat/${chatId}`);
    const bilalMember = ashaView.data.members.find((m) => m.userId === bilal.id);
    ok("  read: Bilal's unread gone, and Asha sees how far he read — her blue ticks", read.status === 200 && !!bilalMember?.lastReadAt && bilalMember.lastReadAt >= sent.data.createdAt, JSON.stringify(read.data));
    const fileId = sent.data.attachments[0]!.id;
    const picture = await raw(bilalPhone, "GET", `/chat/files/${fileId}`);
    ok("the picture: Bilal gets it", picture.status === 200 && picture.headers.get("content-type") === "image/png" && Buffer.from(await picture.arrayBuffer()).equals(PNG), picture.status);
    ok("  Chetan, not in the chat, doesn't", (await raw(chetanPhone, "GET", `/chat/files/${fileId}`)).status === 404);
    ok("  nor can Chetan open the chat", (await call(chetanPhone, "GET", `/chat/${chatId}`)).status === 404);

    section("Replies, reactions, edits, deletes, pins");
    const replyForm = new FormData();
    replyForm.append("body", "Thanks, looking now");
    replyForm.append("replyToId", sent.data.id);
    const reply = await call<Message>(bilalPhone, "POST", `/chat/${chatId}/messages`, replyForm);
    ok("Bilal answers it", reply.status === 201 && reply.data.replyTo?.id === sent.data.id, reply.error?.message);
    const reacted = await call<{ emoji: string; userIds: string[] }[]>(ashaPhone, "POST", `/chat/messages/${reply.data.id}/react`, { emoji: "👍" });
    ok("Asha reacts 👍", reacted.status === 200 && reacted.data.some((r) => r.emoji === "👍" && r.userIds.includes(asha.id)));
    ok("  an emoji that isn't one of the six: refused", (await call(ashaPhone, "POST", `/chat/messages/${reply.data.id}/react`, { emoji: "🦄" })).status === 422);
    const edited = await call<Message>(bilalPhone, "PATCH", `/chat/messages/${reply.data.id}`, { body: "Thanks — looking now" });
    ok("Bilal edits his", edited.status === 200 && edited.data.body === "Thanks — looking now" && !!edited.data.editedAt);
    ok("  Asha can't edit Bilal's", (await call(ashaPhone, "PATCH", `/chat/messages/${reply.data.id}`, { body: "hijacked" })).status === 422);
    const pinned = await call<{ messageId: string }[]>(ashaPhone, "POST", `/chat/messages/${sent.data.id}/pin`, { pinned: true });
    ok("a pin at the top of the chat", pinned.status === 200 && pinned.data.some((p) => p.messageId === sent.data.id));
    const extra = new FormData();
    extra.append("body", "oops, wrong chat");
    const oops = await call<Message>(ashaPhone, "POST", `/chat/${chatId}/messages`, extra);
    const gone = await call<Message>(ashaPhone, "DELETE", `/chat/messages/${oops.data.id}`);
    ok("deleted for everyone", gone.status === 200 && !!gone.data.deletedAt && gone.data.body === "");
    ok("  nothing to send: refused in the action's words", (await call(ashaPhone, "POST", `/chat/${chatId}/messages`, new FormData())).status === 422);
    ok("typing is passed on", (await call(ashaPhone, "POST", `/chat/${chatId}/typing`)).status === 200);

    section("The live stream");
    const stream = await raw(bilalPhone, "GET", "/chat/stream");
    ok("Bilal's phone listens", stream.status === 200 && (stream.headers.get("content-type") ?? "").startsWith("text/event-stream"), stream.status);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let heard = "";
    const live = new FormData();
    live.append("body", `${TAG} live one`);
    await call(ashaPhone, "POST", `/chat/${chatId}/messages`, live);
    const until = Date.now() + 5000;
    while (Date.now() < until && !heard.includes(`${TAG} live one`)) {
      const chunk = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), 1000))]);
      if (chunk.value) heard += decoder.decode(chunk.value);
    }
    await reader.cancel();
    ok("  and hears Asha's message as she sends it", heard.includes('"type":"ready"') && heard.includes(`${TAG} live one`), heard.slice(0, 120));

    section("A group, muting, searching");
    const group = await call<{ chat_id: string }>(ashaPhone, "POST", "/chat/groups", { name: `${TAG} North`, member_ids: [bilal.id, chetan.id] });
    ok("a group of three, Asha its admin", group.status === 201 && !!group.data.chat_id, group.error?.message ?? group.status);
    const hello = new FormData();
    hello.append("body", `Welcome @${TAG} Chetan`);
    const mentioned = await call<Message & { mentionIds: string[] }>(ashaPhone, "POST", `/chat/${group.data.chat_id}/messages`, hello);
    ok("  an @mention, worked out from the name", mentioned.status === 201 && mentioned.data.mentionIds.includes(chetan.id), JSON.stringify(mentioned.data?.mentionIds));
    const chetanRow = (await call<Summary[]>(chetanPhone, "GET", "/chat/summaries")).data.find((s) => s.id === group.data.chat_id);
    ok("  Chetan's row says he was mentioned", !!chetanRow && chetanRow.unread >= 1 && chetanRow.mentioned);
    const muted = await call(chetanPhone, "POST", `/chat/${group.data.chat_id}/mute`, { hours: 8 });
    ok("Chetan mutes it", muted.status === 200 && !!(await call<Summary[]>(chetanPhone, "GET", "/chat/summaries")).data.find((s) => s.id === group.data.chat_id)?.mutedUntil);
    const left = await call(chetanPhone, "POST", `/chat/${group.data.chat_id}/leave`);
    ok("  and leaves; his row says so", left.status === 200 && !!(await call<Summary[]>(chetanPhone, "GET", "/chat/summaries")).data.find((s) => s.id === group.data.chat_id)?.left);
    const after = new FormData();
    after.append("body", "can I still write?");
    ok("  nothing more from him there", (await call(chetanPhone, "POST", `/chat/${group.data.chat_id}/messages`, after)).status === 422);
    const found = await call<{ chatId: string; messageId: string }[]>(bilalPhone, "GET", "/chat/search?q=quote");
    ok("searching Bilal's chats finds the quote", found.status === 200 && found.data.some((h) => h.messageId === sent.data.id));
    ok("  Chetan's search doesn't reach a chat he isn't in", !(await call<{ messageId: string }[]>(chetanPhone, "GET", "/chat/search?q=quote")).data.some((h) => h.messageId === sent.data.id));
  } finally {
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    failures += 1;
  })
  .finally(() => {
    console.log(failures ? `\n${failures} failed.` : "\nAll passed.");
    process.exit(failures ? 1 : 0);
  });
