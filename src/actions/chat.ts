"use server";

import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser, accessContextFor } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { tenantKey } from "@/lib/tenancy/cache";
import { PEOPLE_ONLY } from "@/lib/people";
import { getDownlineUserIds } from "@/lib/org-chart";
import { notifyUser } from "@/lib/notify";
import { pushChatToPhones } from "@/lib/app/push";
import { notMigratedYet } from "@/lib/not-migrated";
import { parseRecordRef } from "@/lib/record-url";
import { companyAccess, leadAccess, orderAccess, ticketAccess } from "@/lib/authz/access";
import { formatCompanyId, formatLeadId, formatOrderId } from "@/lib/order-id";
import { formatTicketId } from "@/lib/tickets";
import { listeningIn, publish } from "@/lib/chat/bus";
import {
  DELETE_WINDOW_MS,
  EDIT_WINDOW_MS,
  MAX_BODY,
  MAX_FILES,
  MAX_FILES_BYTES,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_NAME,
  MAX_PINS,
  PAGE_SIZE,
  RECORD_LINK_KINDS,
  chatFileType,
  directKeyFor,
  isMuted,
  isReaction,
  mentionsIn,
  type RecordLinkKind,
} from "@/lib/chat/rules";
import {
  announceReceipt,
  chatSettings,
  currentMemberIds,
  deliverToListening,
  lastSeenOf,
  membersView,
  membershipOf,
  messageInclude,
  postSystemLine,
  summariesFor,
  pinsOf,
  reactionsOf,
  withReactions,
  toMessageView,
  unreadTotal,
  visibleTo,
} from "@/lib/chat/server";
import type { ChatMemberView, ChatMessageView, ChatPerson, ChatPinView, ChatReactionView, ChatSummary } from "@/lib/chat/types";
import type { ActionResult } from "@/actions/company";
import { filteredWordsRefusal } from "@/lib/word-filter/server";
import { listLeadMasker, maskLead } from "@/lib/leads/masking";

/**
 * Team chat: one-to-one and group conversations between the people of the workspace (src/lib/chat).
 *
 * Every function is the signed-in person acting as themselves. Chat is private, so none of it works
 * while an admin is viewing as somebody: their chats would open as that person's, and anything sent
 * would be sent in their name.
 */

const PRIVATE = "Chat is private to each person, so it isn't available while viewing as somebody else.";

async function chatUser() {
  const user = await requireModuleUser("chat");
  if (await refuseWhileViewingAs()) throw new Error(PRIVATE);
  return user;
}

/** For the actions that answer with a result rather than throwing. */
async function chatUserOrError(): Promise<{ user: Awaited<ReturnType<typeof chatUser>> } | { error: string }> {
  try {
    return { user: await chatUser() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Chat isn't available." };
  }
}

const fail = (error: string) => ({ ok: false as const, error });

// ─── Opening chat ─────────────────────────────────────────────────────────────────────────────────

export type ChatBootstrap = {
  me: { id: string; name: string };
  chats: ChatSummary[];
  people: ChatPerson[];
  departments: { id: string; name: string; memberIds: string[] }[];
  /** The people who report to me, at any depth — "add my team" when making a group. */
  myTeam: string[];
  online: string[];
  lastSeen: Record<string, string>;
  attachmentsViewOnly: boolean;
};

/** Everything the chat screen needs to draw itself. */
export async function chatBootstrap(): Promise<ChatBootstrap> {
  const user = await chatUser();
  const [chats, peopleRows, departments, myTeam, settings, tenantId] = await Promise.all([
    summariesFor(user.id),
    db.user.findMany({
      where: { id: { not: user.id }, ...PEOPLE_ONLY },
      select: { id: true, name: true, photoUpdatedAt: true, active: true, department: { select: { name: true } } },
      orderBy: { name: "asc" },
    }),
    db.department.findMany({ select: { id: true, name: true, members: { where: { active: true, ...PEOPLE_ONLY }, select: { id: true } } }, orderBy: { name: "asc" } }),
    getDownlineUserIds(user.id),
    chatSettings(),
    tenantKey(),
  ]);
  const people: ChatPerson[] = peopleRows.map((p) => ({
    id: p.id,
    name: p.name,
    photoUpdatedAt: p.photoUpdatedAt?.toISOString() ?? null,
    department: p.department?.name ?? null,
    active: p.active,
  }));
  const online = listeningIn(tenantId);
  return {
    me: { id: user.id, name: user.name ?? "" },
    chats,
    people,
    departments: departments.map((d) => ({ id: d.id, name: d.name, memberIds: d.members.map((m) => m.id).filter((id) => id !== user.id) })),
    myTeam: myTeam.filter((id) => id !== user.id),
    online,
    lastSeen: await lastSeenOf(people.map((p) => p.id).filter((id) => !online.includes(id))),
    attachmentsViewOnly: settings.attachmentsViewOnly,
  };
}

/** Rows of the chat list again — all of them, or these. */
export async function listChatSummaries(chatIds?: string[]): Promise<ChatSummary[]> {
  const user = await chatUser();
  return summariesFor(user.id, chatIds?.slice(0, 50));
}

export type OpenedChat = { summary: ChatSummary; members: ChatMemberView[]; messages: ChatMessageView[]; hasMore: boolean; pins: ChatPinView[] };

/**
 * A conversation's newest page — or, given one of its messages (a search result), the page around it.
 * Null when this person was never in the chat.
 */
export async function openChat(chatId: string, around?: string): Promise<OpenedChat | null> {
  const user = await chatUser();
  const member = await membershipOf(chatId, user.id);
  if (!member) return null;
  const visible = visibleTo(member);
  let rows;
  let hasMore: boolean;
  const anchor = around ? await db.chatMessage.findFirst({ where: { id: around, chatId, ...visible }, select: { createdAt: true } }) : null;
  if (anchor) {
    const [before, after] = await Promise.all([
      db.chatMessage.findMany({ where: { chatId, AND: [visible, { createdAt: { lt: anchor.createdAt } }] }, include: messageInclude, orderBy: { createdAt: "desc" }, take: PAGE_SIZE / 2 + 1 }),
      db.chatMessage.findMany({ where: { chatId, AND: [visible, { createdAt: { gte: anchor.createdAt } }] }, include: messageInclude, orderBy: { createdAt: "asc" } }),
    ]);
    hasMore = before.length > PAGE_SIZE / 2;
    rows = [...before.slice(0, PAGE_SIZE / 2).reverse(), ...after];
  } else {
    const newest = await db.chatMessage.findMany({ where: { chatId, ...visible }, include: messageInclude, orderBy: { createdAt: "desc" }, take: PAGE_SIZE + 1 });
    hasMore = newest.length > PAGE_SIZE;
    rows = newest.slice(0, PAGE_SIZE).reverse();
  }
  const [summary] = await summariesFor(user.id, [chatId]);
  return {
    summary: summary ?? (await summaryFallback(chatId, user.id)),
    members: await membersView(chatId),
    messages: await withReactions(rows.map(toMessageView)),
    pins: await pinsOf(chatId, member),
    hasMore,
  };
}

/** A direct chat with no messages yet isn't in the list for the other person; opening it still needs a row. */
async function summaryFallback(chatId: string, userId: string): Promise<ChatSummary> {
  const chat = await db.chat.findUniqueOrThrow({ where: { id: chatId }, include: { members: { where: { leftAt: null }, include: { user: { select: { name: true, photoUpdatedAt: true, active: true } } } } } });
  const other = chat.members.find((m) => m.userId !== userId) ?? null;
  return {
    id: chat.id,
    kind: chat.kind,
    title: chat.kind === "GROUP" ? chat.name ?? "Group" : other?.user.name ?? "Former colleague",
    otherUserId: other?.userId ?? null,
    otherPhotoUpdatedAt: other?.user.photoUpdatedAt?.toISOString() ?? null,
    otherActive: other?.user.active ?? false,
    memberCount: chat.members.length,
    preview: "",
    lastMessageAt: chat.createdAt.toISOString(),
    unread: 0,
    mentioned: false,
    mutedUntil: null,
    isAdmin: false,
    left: false,
  };
}

/** The page before the oldest one shown. */
export async function loadEarlierMessages(chatId: string, before: string): Promise<{ messages: ChatMessageView[]; hasMore: boolean }> {
  const user = await chatUser();
  const member = await membershipOf(chatId, user.id);
  const at = new Date(before);
  if (!member || Number.isNaN(at.getTime())) return { messages: [], hasMore: false };
  const rows = await db.chatMessage.findMany({
    where: { chatId, AND: [visibleTo(member), { createdAt: { lt: at } }] },
    include: messageInclude,
    orderBy: { createdAt: "desc" },
    take: PAGE_SIZE + 1,
  });
  return { messages: await withReactions(rows.slice(0, PAGE_SIZE).reverse().map(toMessageView)), hasMore: rows.length > PAGE_SIZE };
}

// ─── Sending ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Sends a message: `chatId`, `body`, optionally `replyToId`, and up to five `files` together under
 * 5 MB. The people it @mentions are read from the text against the chat's members, so nobody can be
 * "mentioned" into a chat they aren't in.
 */
export async function sendChatMessage(form: FormData): Promise<ActionResult<ChatMessageView>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;

  const chatId = String(form.get("chatId") ?? "");
  const body = String(form.get("body") ?? "").replace(/\r\n/g, "\n").trim();
  const replyToId = String(form.get("replyToId") ?? "") || null;
  const files = form.getAll("files").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);

  const member = await membershipOf(chatId, user.id);
  if (!member) return fail("That chat isn't one of yours.");
  if (member.leftAt) return fail(member.chat.kind === "GROUP" ? "You're no longer in this group." : "You can't send to this chat.");
  if (!body && files.length === 0) return fail("Write something, or attach a file.");
  if (body.length > MAX_BODY) return fail(`Messages can be up to ${MAX_BODY.toLocaleString("en-IN")} characters — this one is ${body.length.toLocaleString("en-IN")}.`);
  if (files.length > MAX_FILES) return fail(`Up to ${MAX_FILES} files at a time.`);
  // Words the workspace keeps out of chat (src/lib/word-filter): not sent, and only the sender is told.
  const filtered = await filteredWordsRefusal("CHAT", [body]);
  if (filtered) return fail(filtered);
  const totalBytes = files.reduce((t, f) => t + f.size, 0);
  if (totalBytes > MAX_FILES_BYTES) return fail("Files can come to 5 MB at most on one message.");
  const typed: { file: File; mimeType: string }[] = [];
  for (const file of files) {
    const mimeType = chatFileType(file.type, file.name);
    if (!mimeType) return fail(`"${file.name}" isn't a kind of file chat takes — pictures, PDFs, office documents, text and zip files are.`);
    typed.push({ file, mimeType });
  }

  const members = await db.chatMember.findMany({
    where: { chatId, leftAt: null },
    select: { userId: true, mutedUntil: true, user: { select: { name: true, active: true } } },
  });
  if (member.chat.kind === "DIRECT") {
    const other = members.find((m) => m.userId !== user.id);
    if (!other || !other.user.active) return fail(`${other?.user.name ?? "They"} can't receive messages — their account is switched off.`);
  }
  if (replyToId) {
    const quoted = await db.chatMessage.findFirst({ where: { id: replyToId, chatId, ...visibleTo(member) }, select: { id: true } });
    if (!quoted) return fail("The message you replied to isn't in this chat any more.");
  }
  const mentionIds =
    member.chat.kind === "GROUP" ? mentionsIn(body, members.filter((m) => m.userId !== user.id).map((m) => ({ id: m.userId, name: m.user.name }))) : [];

  const datas = await Promise.all(typed.map(async (t) => Buffer.from(await t.file.arrayBuffer())));
  const row = await db.$transaction(async (tx) => {
    const created = await tx.chatMessage.create({
      data: {
        chatId,
        senderId: user.id,
        body,
        replyToId,
        mentionIds,
        attachments: { create: typed.map((t, i) => ({ fileName: t.file.name.slice(0, 200), mimeType: t.mimeType, size: t.file.size, data: datas[i]! })) },
      },
      include: messageInclude,
    });
    await tx.chat.update({ where: { id: chatId }, data: { lastMessageAt: created.createdAt } });
    await tx.chatMember.update({ where: { id: member.id }, data: { lastReadAt: created.createdAt, lastDeliveredAt: created.createdAt } });
    return created;
  });
  const message = toMessageView(row);

  const mutedBy = new Map(members.map((m) => [m.userId, isMuted(m.mutedUntil)]));
  await publish(
    members.map((m) => m.userId),
    (userId) => ({
      type: "message",
      message,
      muted: userId === user.id || !!mutedBy.get(userId),
      mentioned: mentionIds.includes(userId),
      chatTitle: member.chat.kind === "GROUP" ? member.chat.name : user.name,
    }),
  );
  await deliverToListening(chatId, members.map((m) => m.userId), user.id);

  // Who and where, never what: the message stays in the chat.
  for (const mentioned of mentionIds) {
    await notifyUser({ userId: mentioned, type: "CHAT_MENTION", title: `${user.name} mentioned you in ${member.chat.name ?? "a group"}`, link: `/chat?c=${chatId}` });
  }
  // And on the others' phones, the app's way (src/lib/app/push.ts): who and where, never what — not to whoever muted
  // the chat, nor to somebody just mentioned, whose bell already rang. Never fails the message.
  const phones = members.filter((m) => m.userId !== user.id && !mutedBy.get(m.userId) && !mentionIds.includes(m.userId)).map((m) => m.userId);
  const pushTitle = member.chat.kind === "GROUP" ? `${user.name} in ${member.chat.name ?? "a group"}` : `New message from ${user.name}`;
  await pushChatToPhones(phones, { id: chatId, title: pushTitle }).catch((err) => console.error("[chat] push failed", err));
  return { ok: true, data: message };
}

/** Changes a message's text, within fifteen minutes of sending it. */
export async function editChatMessage(messageId: string, newBody: string): Promise<ActionResult<ChatMessageView>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const row = await db.chatMessage.findUnique({ where: { id: messageId }, include: { _count: { select: { attachments: true } } } });
  if (!row || row.senderId !== user.id || row.kind !== "TEXT") return fail("You can only edit your own messages.");
  if (row.deletedAt) return fail("That message was deleted.");
  if (Date.now() - row.createdAt.getTime() > EDIT_WINDOW_MS) return fail("Messages can be edited for 15 minutes after sending.");
  const member = await membershipOf(row.chatId, user.id);
  if (!member || member.leftAt) return fail("You're no longer in this chat.");
  const body = newBody.replace(/\r\n/g, "\n").trim();
  if (!body && row._count.attachments === 0) return fail("A message can't be empty — delete it instead.");
  if (body.length > MAX_BODY) return fail(`Messages can be up to ${MAX_BODY.toLocaleString("en-IN")} characters.`);
  if (body === row.body) return { ok: true, data: (await messageViewOf(messageId))! };
  // Words the workspace keeps out of chat (src/lib/word-filter): not sent, and only the sender is told.
  const filtered = await filteredWordsRefusal("CHAT", [body]);
  if (filtered) return fail(filtered);

  const members = await db.chatMember.findMany({ where: { chatId: row.chatId, leftAt: null }, select: { userId: true, user: { select: { name: true } } } });
  const mentionIds =
    member.chat.kind === "GROUP" ? mentionsIn(body, members.filter((m) => m.userId !== user.id).map((m) => ({ id: m.userId, name: m.user.name }))) : [];
  await db.chatMessage.update({ where: { id: messageId }, data: { body, editedAt: new Date(), mentionIds } });
  const message = (await messageViewOf(messageId))!;
  await publish(members.map((m) => m.userId), { type: "message-updated", message });
  return { ok: true, data: message };
}

/** Deletes a message for everyone, within an hour of sending it: its text and files go; a line saying so stays. */
export async function deleteChatMessage(messageId: string): Promise<ActionResult<ChatMessageView>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const row = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!row || row.senderId !== user.id || row.kind !== "TEXT") return fail("You can only delete your own messages.");
  if (row.deletedAt) return { ok: true, data: (await messageViewOf(messageId))! };
  if (Date.now() - row.createdAt.getTime() > DELETE_WINDOW_MS) return fail("Messages can be deleted for everyone for an hour after sending.");
  await db.$transaction(async (tx) => {
    await tx.chatAttachment.deleteMany({ where: { messageId } });
    await tx.chatMessage.update({ where: { id: messageId }, data: { body: "", mentionIds: [], deletedAt: new Date() } });
  });
  // Its reactions and its pin go with its text — apart from the transaction, so a workspace without
  // those tables yet still deletes.
  let unpinned = false;
  try {
    await db.chatReaction.deleteMany({ where: { messageId } });
    unpinned = (await db.chatPin.deleteMany({ where: { messageId } })).count > 0;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const message = (await messageViewOf(messageId))!;
  const members = await currentMemberIds(row.chatId);
  await publish(members, { type: "message-updated", message });
  if (unpinned) await publish(members, { type: "pins-changed", chatId: row.chatId });
  return { ok: true, data: message };
}

async function messageViewOf(id: string): Promise<ChatMessageView | null> {
  const row = await db.chatMessage.findUnique({ where: { id }, include: messageInclude });
  return row ? (await withReactions([toMessageView(row)]))[0]! : null;
}

// ─── Reactions and pins ───────────────────────────────────────────────────────────────────────────

/** The message, if this person may act on it now: in a chat they are still in, from a part they can read. */
async function actableMessage(messageId: string, userId: string) {
  const row = await db.chatMessage.findUnique({ where: { id: messageId }, select: { id: true, chatId: true, kind: true, createdAt: true, deletedAt: true, body: true } });
  if (!row || row.kind !== "TEXT" || row.deletedAt) return null;
  const member = await membershipOf(row.chatId, userId);
  if (!member || member.leftAt || row.createdAt < member.joinedAt) return null;
  return { row, member };
}

/**
 * Reacts to a message with one of the six (src/lib/chat/rules.ts REACTIONS): one reaction each —
 * another emoji replaces mine, the same one again, or null, takes it back.
 */
export async function reactToChatMessage(messageId: string, emoji: string | null): Promise<ActionResult<ChatReactionView[]>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const found = await actableMessage(messageId, user.id);
  if (!found) return fail("That message isn't one you can react to.");
  if (emoji !== null && !isReaction(emoji)) return fail("Pick one of the reactions offered.");
  const key = { messageId_userId: { messageId, userId: user.id } };
  const mine = await db.chatReaction.findUnique({ where: key, select: { emoji: true } });
  if (emoji === null || mine?.emoji === emoji) {
    if (mine) await db.chatReaction.delete({ where: key });
  } else {
    await db.chatReaction.upsert({ where: key, create: { messageId, userId: user.id, emoji }, update: { emoji, createdAt: new Date() } });
  }
  const reactions = (await reactionsOf([messageId])).get(messageId) ?? [];
  await publish(await currentMemberIds(found.row.chatId), { type: "reactions", chatId: found.row.chatId, messageId, reactions });
  return { ok: true, data: reactions };
}

/** Pins a message to the top of its chat, or unpins it. Any member may; three at most — a fourth unpins the oldest. */
export async function pinChatMessage(messageId: string, pinned: boolean): Promise<ActionResult<ChatPinView[]>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const found = await actableMessage(messageId, user.id);
  if (!found) return fail("That message can't be pinned.");
  const { row, member } = found;
  const existing = await db.chatPin.findUnique({ where: { messageId }, select: { id: true } });
  if (pinned && !existing) {
    await db.$transaction(async (tx) => {
      await tx.chatPin.create({ data: { chatId: row.chatId, messageId, pinnedById: user.id } });
      const pins = await tx.chatPin.findMany({ where: { chatId: row.chatId }, orderBy: { pinnedAt: "desc" }, select: { id: true } });
      const surplus = pins.slice(MAX_PINS).map((p) => p.id);
      if (surplus.length) await tx.chatPin.deleteMany({ where: { id: { in: surplus } } });
    });
    await postSystemLine(row.chatId, `${user.name} pinned a message`);
  } else if (!pinned && existing) {
    await db.chatPin.delete({ where: { messageId } });
  }
  await publish(await currentMemberIds(row.chatId), { type: "pins-changed", chatId: row.chatId });
  return { ok: true, data: await pinsOf(row.chatId, member) };
}

/** A chat's pins, as this member may see them — asked again whenever they change. */
export async function chatPins(chatId: string): Promise<ChatPinView[]> {
  const user = await chatUser();
  const member = await membershipOf(chatId, user.id);
  return member ? pinsOf(chatId, member) : [];
}

// ─── Reading, typing ──────────────────────────────────────────────────────────────────────────────

/** I've read this chat up to now: the blue ticks on the other side, and my unread count again. */
export async function markChatRead(chatId: string): Promise<{ total: number }> {
  const user = await chatUser();
  const member = await membershipOf(chatId, user.id);
  if (member && !member.leftAt) {
    const now = new Date();
    await db.chatMember.update({ where: { id: member.id }, data: { lastReadAt: now, lastDeliveredAt: now } });
    await announceReceipt(chatId, { userId: user.id, lastDeliveredAt: now, lastReadAt: now });
  }
  const total = await unreadTotal(user.id);
  // My other tabs and the rail, so their counts drop too.
  await publish([user.id], { type: "unread", total });
  return { total };
}

/** My number on the chat button. */
export async function chatUnreadCount(): Promise<number> {
  const user = await chatUser();
  return unreadTotal(user.id);
}

/** "Priya is typing…" to the others in the chat. Sent at most every few seconds by the composer. */
export async function chatTyping(chatId: string): Promise<void> {
  const user = await chatUser();
  const member = await membershipOf(chatId, user.id);
  if (!member || member.leftAt) return;
  const others = (await currentMemberIds(chatId)).filter((id) => id !== user.id);
  await publish(others, { type: "typing", chatId, userId: user.id, name: user.name ?? "" });
}

// ─── Starting chats ───────────────────────────────────────────────────────────────────────────────

/** The one direct chat with this colleague — found, or started. */
export async function startDirectChat(otherUserId: string): Promise<ActionResult<{ chatId: string }>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  if (otherUserId === user.id) return fail("That's you.");
  const other = await db.user.findFirst({ where: { id: otherUserId, ...PEOPLE_ONLY }, select: { id: true, active: true } });
  if (!other) return fail("That person isn't in this workspace.");
  const directKey = directKeyFor(user.id, otherUserId);
  const existing = await db.chat.findUnique({ where: { directKey }, select: { id: true } });
  if (existing) return { ok: true, data: { chatId: existing.id } };
  if (!other.active) return fail("Their account is switched off, so a new chat can't be started with them.");
  try {
    const chat = await db.chat.create({
      data: { kind: "DIRECT", directKey, createdById: user.id, members: { create: [{ userId: user.id }, { userId: otherUserId }] } },
      select: { id: true },
    });
    return { ok: true, data: { chatId: chat.id } };
  } catch (err) {
    // Both of them started it at the same moment: the other one won, which is the same chat.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const won = await db.chat.findUnique({ where: { directKey }, select: { id: true } });
      if (won) return { ok: true, data: { chatId: won.id } };
    }
    throw err;
  }
}

/** Active colleagues among these ids, in the order given. */
async function colleagues(ids: string[], me: string): Promise<{ id: string; name: string }[]> {
  const wanted = [...new Set(ids)].filter((id) => id && id !== me);
  if (wanted.length === 0) return [];
  const rows = await db.user.findMany({ where: { id: { in: wanted }, active: true, ...PEOPLE_ONLY }, select: { id: true, name: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((id) => byId.get(id)).filter((r): r is { id: string; name: string } => !!r);
}

const listOfNames = (names: string[]) =>
  names.length <= 3 ? names.join(names.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, " and $1") : `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;

/** A new group, with me as its admin. */
export async function createGroupChat(input: { name: string; memberIds: string[] }): Promise<ActionResult<{ chatId: string }>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) return fail("Give the group a name.");
  if (name.length > MAX_GROUP_NAME) return fail(`Group names can be up to ${MAX_GROUP_NAME} characters.`);
  // Words the workspace keeps out of chat (src/lib/word-filter): not sent, and only the sender is told.
  const filtered = await filteredWordsRefusal("CHAT", [name]);
  if (filtered) return fail(filtered);
  const people = await colleagues(input.memberIds ?? [], user.id);
  if (people.length === 0) return fail("Add at least one person.");
  if (people.length + 1 > MAX_GROUP_MEMBERS) return fail(`A group can have up to ${MAX_GROUP_MEMBERS} people.`);
  const chat = await db.chat.create({
    data: {
      kind: "GROUP",
      name,
      createdById: user.id,
      members: { create: [{ userId: user.id, isAdmin: true }, ...people.map((p) => ({ userId: p.id }))] },
    },
    select: { id: true },
  });
  await postSystemLine(chat.id, `${user.name} created the group "${name}"`);
  await publish([user.id, ...people.map((p) => p.id)], { type: "chat-changed", chatId: chat.id });
  return { ok: true, data: { chatId: chat.id } };
}

// ─── Running a group ──────────────────────────────────────────────────────────────────────────────

async function groupAdmin(chatId: string, userId: string): Promise<{ error: string } | { name: string | null }> {
  const member = await membershipOf(chatId, userId);
  if (!member || member.chat.kind !== "GROUP") return { error: "That group isn't one of yours." };
  if (member.leftAt) return { error: "You're no longer in this group." };
  if (!member.isAdmin) return { error: "Only the group's admins can do that." };
  return { name: member.chat.name };
}

export async function renameGroupChat(chatId: string, newName: string): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const admin = await groupAdmin(chatId, user.id);
  if ("error" in admin) return fail(admin.error);
  const name = newName.replace(/\s+/g, " ").trim();
  if (!name) return fail("Give the group a name.");
  if (name.length > MAX_GROUP_NAME) return fail(`Group names can be up to ${MAX_GROUP_NAME} characters.`);
  if (name === admin.name) return { ok: true, data: null };
  // Words the workspace keeps out of chat (src/lib/word-filter): not sent, and only the sender is told.
  const filtered = await filteredWordsRefusal("CHAT", [name]);
  if (filtered) return fail(filtered);
  await db.chat.update({ where: { id: chatId }, data: { name } });
  await postSystemLine(chatId, `${user.name} renamed the group to "${name}"`);
  await publish(await currentMemberIds(chatId), { type: "chat-changed", chatId });
  return { ok: true, data: null };
}

export async function addGroupMembers(chatId: string, userIds: string[]): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const admin = await groupAdmin(chatId, user.id);
  if ("error" in admin) return fail(admin.error);
  const current = new Set(await currentMemberIds(chatId));
  const people = (await colleagues(userIds, user.id)).filter((p) => !current.has(p.id));
  if (people.length === 0) return fail("Everyone you picked is already in the group.");
  if (current.size + people.length > MAX_GROUP_MEMBERS) return fail(`A group can have up to ${MAX_GROUP_MEMBERS} people.`);
  const now = new Date();
  await db.$transaction(async (tx) => {
    for (const p of people) {
      // Somebody who left and is added back starts reading from now, as a newcomer does.
      await tx.chatMember.upsert({
        where: { chatId_userId: { chatId, userId: p.id } },
        create: { chatId, userId: p.id, joinedAt: now },
        update: { leftAt: null, joinedAt: now, isAdmin: false, lastReadAt: null, lastDeliveredAt: null, mutedUntil: null },
      });
    }
  });
  await postSystemLine(chatId, `${user.name} added ${listOfNames(people.map((p) => p.name))}`);
  await publish(await currentMemberIds(chatId), { type: "chat-changed", chatId });
  return { ok: true, data: null };
}

export async function removeGroupMember(chatId: string, userId: string): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  if (userId === user.id) return fail("To leave the group, use Leave group.");
  const admin = await groupAdmin(chatId, user.id);
  if ("error" in admin) return fail(admin.error);
  const target = await db.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } }, include: { user: { select: { name: true } } } });
  if (!target || target.leftAt) return fail("They're not in the group.");
  await db.chatMember.update({ where: { id: target.id }, data: { leftAt: new Date(), isAdmin: false } });
  await postSystemLine(chatId, `${user.name} removed ${target.user.name}`);
  await publish([...(await currentMemberIds(chatId)), userId], { type: "chat-changed", chatId });
  return { ok: true, data: null };
}

export async function setGroupAdmin(chatId: string, userId: string, makeAdmin: boolean): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const admin = await groupAdmin(chatId, user.id);
  if ("error" in admin) return fail(admin.error);
  const target = await db.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } }, include: { user: { select: { name: true } } } });
  if (!target || target.leftAt) return fail("They're not in the group.");
  if (!makeAdmin && userId === user.id) {
    const others = await db.chatMember.count({ where: { chatId, leftAt: null, isAdmin: true, userId: { not: user.id } } });
    if (others === 0) return fail("Make somebody else an admin first — a group needs one.");
  }
  await db.chatMember.update({ where: { id: target.id }, data: { isAdmin: makeAdmin } });
  await postSystemLine(chatId, makeAdmin ? `${user.name} made ${target.user.name} an admin` : `${target.user.name} is no longer an admin`);
  await publish(await currentMemberIds(chatId), { type: "chat-changed", chatId });
  return { ok: true, data: null };
}

export async function leaveGroupChat(chatId: string): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const member = await membershipOf(chatId, user.id);
  if (!member || member.chat.kind !== "GROUP") return fail("That group isn't one of yours.");
  if (member.leftAt) return { ok: true, data: null };
  await db.$transaction(async (tx) => {
    await tx.chatMember.update({ where: { id: member.id }, data: { leftAt: new Date(), isAdmin: false } });
    // A group is never left without an admin: the longest-standing member takes it on.
    const admins = await tx.chatMember.count({ where: { chatId, leftAt: null, isAdmin: true } });
    if (admins === 0) {
      const next = await tx.chatMember.findFirst({ where: { chatId, leftAt: null }, orderBy: { joinedAt: "asc" } });
      if (next) await tx.chatMember.update({ where: { id: next.id }, data: { isAdmin: true } });
    }
  });
  await postSystemLine(chatId, `${user.name} left`, [user.id]);
  await publish([...(await currentMemberIds(chatId)), user.id], { type: "chat-changed", chatId });
  return { ok: true, data: null };
}

/** No sound or count for this chat, for a while or for good; null to hear it again. @mentions still count. */
export async function muteChat(chatId: string, hours: number | null): Promise<ActionResult<null>> {
  const auth = await chatUserOrError();
  if ("error" in auth) return fail(auth.error);
  const { user } = auth;
  const member = await membershipOf(chatId, user.id);
  if (!member) return fail("That chat isn't one of yours.");
  const until = hours && hours > 0 ? new Date(Date.now() + Math.min(hours, 24 * 365 * 100) * 3_600_000) : null;
  await db.chatMember.update({ where: { id: member.id }, data: { mutedUntil: until } });
  await publish([user.id], { type: "chat-changed", chatId });
  await publish([user.id], { type: "unread", total: await unreadTotal(user.id) });
  return { ok: true, data: null };
}

// ─── Search ───────────────────────────────────────────────────────────────────────────────────────

export type ChatSearchHit = { chatId: string; messageId: string; chatTitle: string; senderName: string | null; snippet: string; createdAt: string };

/** Messages in my chats containing these words — only the parts of each chat I could read anyway. */
export async function searchChatMessages(query: string): Promise<ChatSearchHit[]> {
  const user = await chatUser();
  const q = query.replace(/\s+/g, " ").trim();
  if (q.length < 2) return [];
  const memberships = await db.chatMember.findMany({ where: { userId: user.id }, select: { chatId: true, joinedAt: true, leftAt: true } });
  if (memberships.length === 0) return [];
  const rows = await db.chatMessage.findMany({
    where: {
      kind: "TEXT",
      deletedAt: null,
      body: { contains: q, mode: "insensitive" },
      OR: memberships.map((m) => ({ chatId: m.chatId, ...visibleTo(m) })),
    },
    select: { id: true, chatId: true, body: true, createdAt: true, sender: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 30,
  });
  const titles = new Map((await summariesFor(user.id, [...new Set(rows.map((r) => r.chatId))])).map((s) => [s.id, s.title]));
  return rows.map((r) => {
    const at = r.body.toLowerCase().indexOf(q.toLowerCase());
    const start = Math.max(0, at - 40);
    const snippet = `${start > 0 ? "…" : ""}${r.body.slice(start, start + 140).replace(/\s+/g, " ")}${start + 140 < r.body.length ? "…" : ""}`;
    return { chatId: r.chatId, messageId: r.id, chatTitle: titles.get(r.chatId) ?? "Chat", senderName: r.sender?.name ?? null, snippet, createdAt: r.createdAt.toISOString() };
  });
}

// ─── Record cards ─────────────────────────────────────────────────────────────────────────────────

export type ChatRecordCard = { path: string; kind: RecordLinkKind; allowed: boolean; title: string | null; subtitle: string | null };

const MODULE_OF: Record<RecordLinkKind, string> = { companies: "companies", leads: "leads", orders: "orders", tickets: "helpdesk" };

/**
 * What the record links in a message are, for whoever is reading it: the title for somebody who may
 * open that record, and nothing but "a record you can't open" for anybody else — the sender's access
 * is never lent to the reader.
 */
export async function resolveChatRecordLinks(paths: string[]): Promise<ChatRecordCard[]> {
  const user = await chatUser();
  const { openModules } = await accessContextFor(user.id);
  const cards: ChatRecordCard[] = [];
  for (const path of [...new Set(paths)].slice(0, 20)) {
    const match = /^\/(companies|leads|orders|tickets)\/([A-Za-z0-9-]+)$/.exec(path);
    if (!match || !(RECORD_LINK_KINDS as readonly string[]).includes(match[1]!)) continue;
    const kind = match[1] as RecordLinkKind;
    const closed: ChatRecordCard = { path, kind, allowed: false, title: null, subtitle: null };
    if (!openModules.includes(MODULE_OF[kind])) {
      cards.push(closed);
      continue;
    }
    const ref = parseRecordRef(match[2]!);
    cards.push((await recordCard(user.id, kind, ref, path)) ?? closed);
  }
  return cards;
}

async function recordCard(userId: string, kind: RecordLinkKind, ref: ReturnType<typeof parseRecordRef>, path: string): Promise<ChatRecordCard | null> {
  if (kind === "companies") {
    const where = ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id };
    const row = await db.company.findFirst({ where: { AND: [where, await companyAccess(userId)] }, select: { name: true, companySeq: true } });
    return row ? { path, kind, allowed: true, title: row.name, subtitle: formatCompanyId(row.companySeq) } : null;
  }
  if (kind === "leads") {
    const where = ref.kind === "seq" ? { leadSeq: ref.seq } : { id: ref.id };
    const found = await db.lead.findFirst({ where: { AND: [where, await leadAccess(userId)] }, select: { title: true, leadSeq: true, status: true, company: { select: { name: true } } } });
    // Named in the card as this person's field access names a lead in a list.
    const row = found ? maskLead(await listLeadMasker(userId), found) : null;
    return row ? { path, kind, allowed: true, title: row.title, subtitle: [formatLeadId(row.leadSeq), row.company?.name].filter(Boolean).join(" · ") } : null;
  }
  if (kind === "orders") {
    const where = ref.kind === "seq" ? { orderSeq: ref.seq } : { id: ref.id };
    const row = await db.companyProduct.findFirst({ where: { AND: [where, await orderAccess(userId)] }, select: { orderSeq: true, company: { select: { name: true } }, item: { select: { name: true } } } });
    return row ? { path, kind, allowed: true, title: `${formatOrderId(row.orderSeq)} · ${row.company.name}`, subtitle: row.item?.name ?? null } : null;
  }
  const where = ref.kind === "seq" ? { ticketSeq: ref.seq } : { id: ref.id };
  const row = await db.ticket.findFirst({ where: { AND: [where, await ticketAccess(userId)] }, select: { title: true, ticketSeq: true, status: true } });
  return row ? { path, kind, allowed: true, title: row.title, subtitle: `${formatTicketId(row.ticketSeq)} · ${row.status.replaceAll("_", " ").toLowerCase()}` } : null;
}
