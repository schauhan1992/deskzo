import { createHash, randomBytes } from "node:crypto";
import type { ConversationAuthor, ConversationDelivery, InboxChannel, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { tenantKey } from "@/lib/tenancy/cache";
import { listeningIn, publishIn } from "@/lib/chat/bus";
import { intakeLead, type LeadPayload } from "@/lib/lead-capture/intake";
import { newTicketRefusal, writeTicket } from "@/lib/ticket-open";
import { activeWordFilter } from "@/lib/word-filter/server";
import { formatLeadId } from "@/lib/order-id";
import { emitEvent } from "@/lib/automate/events";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { aiAnswer } from "@/lib/inbox/ai";
import { broadcast, onBroadcast } from "@/lib/cluster/hub";
import { botGreeting, botReply, firstNameOf, typingMs, withName, type BotState, type Known } from "@/lib/inbox/bot";
import { INBOX_LIMITS, channelSettings, conversationRef, whatsappWindowOpen, withinHours, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";
import { fetchWhatsAppMedia, markWhatsAppRead, sendWhatsApp, type InboundMedia, type InboundWhatsApp, type WhatsAppStatus } from "@/lib/inbox/whatsapp";

/**
 * The Customer inbox (owner, 24 Oct 2026): every outside conversation in one place — a website's chat
 * bubble with its bot, and WhatsApp, on a shared number or a rep's own. Team chat between colleagues is
 * src/lib/chat and stays apart; email tickets stay in the helpdesk, and a conversation can become one.
 *
 *   · A customer's message is kept, the conversation is linked to the contact on file with that email
 *     or number (and their open lead), and the channel's bot — set answers — takes its turn while it has
 *     the conversation. When it hands over, or a person replies, the bot is done.
 *   · New customers make leads where the channel says so (owner: WhatsApp and bot chats can create
 *     leads): a WhatsApp number on its first message, a website visitor once the bot has their name and
 *     a phone number or email. A person can make one from any conversation.
 *   · Who sees what: a shared channel's conversations, everybody with the inbox; a rep's own number's,
 *     that rep, whoever it is assigned to, and those who see every conversation (`inbox.viewAll`).
 *   · Live: every change is announced on team chat's connection by conversation id only, and each screen
 *     asks again as its own person (src/lib/chat/bus.ts).
 *
 * Whether a person may use the inbox at all is the caller's question (src/actions/inbox.ts); the rules
 * here are about each conversation.
 */

export type InboxViewer = { id: string; viewAll: boolean };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const CLOSED_LEADS = ["WON", "LOST", "DISQUALIFIED"] as const;
const NOT_FOUND = "That conversation isn't there, or isn't yours to see.";

/** Conversations this person may read. */
export function visibleWhere(viewer: InboxViewer): Prisma.ConversationWhereInput {
  if (viewer.viewAll) return {};
  return { OR: [{ channel: { is: { ownerUserId: null } } }, { channel: { is: { ownerUserId: viewer.id } } }, { assignedToUserId: viewer.id }] };
}

/** The same rule, for a row already read. */
export function mayRead(viewer: InboxViewer, c: { assignedToUserId: string | null; channel: { ownerUserId: string | null } }): boolean {
  return viewer.viewAll || c.channel.ownerUserId === null || c.channel.ownerUserId === viewer.id || c.assignedToUserId === viewer.id;
}

/** Tells every open screen in the workspace that this conversation changed — its id, nothing else. Never throws. */
async function announce(conversationId: string): Promise<void> {
  try {
    const tenantId = await tenantKey();
    publishIn(tenantId, listeningIn(tenantId), { type: "inbox", conversationId });
  } catch {
    // Not live: the screens ask again on their own every little while.
  }
}

// ─── Like a person: pacing, typing, seen (owner, 24 Oct 2026: "like a real human agent talks") ───

let pacing = true;

/** For the checks: no waiting between the bot's messages. */
export function setInboxPacing(on: boolean) {
  pacing = on;
}

const pause = (ms: number) => (pacing && ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** How long "typing…" lasts after a staff member's last keystroke. */
const TYPING_MS = 6_000;
/** WhatsApp shows its own "typing…" for up to 25 seconds; asked again no more often than this. */
const WHATSAPP_TYPING_EVERY_MS = 20_000;

type TypingState = { typing: Map<string, { name: string; until: number }>; whatsappAt: Map<string, number>; joined: boolean };

/**
 * Who on the team is typing in which conversation, for the website bubble's "Rahul is typing…". In memory,
 * on `globalThis` (a route and the actions are bundled apart), and told to the container's other web
 * processes (src/lib/cluster/hub.ts) — the bubble's next poll may land on any of them.
 */
function typingState(): TypingState {
  const g = globalThis as { [key: symbol]: TypingState | undefined };
  const key = Symbol.for("deskzo.inbox-typing");
  g[key] ??= { typing: new Map(), whatsappAt: new Map(), joined: false };
  const state = g[key]!;
  if (!state.joined) {
    state.joined = true;
    onBroadcast("inbox:typing", (p) => {
      const { id, name, until } = p as { id: string; name: string; until: number };
      state.typing.set(id, { name, until });
    });
  }
  return state;
}

/** The first name of whoever on the team is typing in this conversation now, or null. */
export function typingIn(conversationId: string, now = Date.now()): string | null {
  const t = typingState().typing.get(conversationId);
  return t && t.until > now ? t.name : null;
}

// ─── The workspace's WhatsApp webhook settings ───────────────────────────────────────────────────

/** The row, made on first use with a random verify token. */
export async function inboxSettings() {
  const existing = await db.inboxSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return db.inboxSettings.upsert({ where: { id: "global" }, create: { id: "global", whatsappVerifyToken: randomBytes(18).toString("base64url") }, update: {} });
}

// ─── Customers on file ───────────────────────────────────────────────────────────────────────────

/** The last ten digits, which is how a number is matched however it was typed. */
const lastDigits = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

/** The contact on file with this email or number — somebody still at their company — and their open lead. */
async function customerOnFile(email: string | null, phone: string | null): Promise<{ contactId: string; companyId: string; leadId: string | null } | null> {
  let contact: { id: string; companyId: string } | null = null;
  if (email) contact = await db.contact.findFirst({ where: { email: { equals: email, mode: "insensitive" }, leftAt: null }, select: { id: true, companyId: true }, orderBy: { createdAt: "asc" } });
  const digits = lastDigits(phone);
  if (!contact && digits.length === 10) {
    const rows = await db.$queryRaw<{ id: string; companyId: string }[]>`
      SELECT id, "companyId" FROM contacts
       WHERE "leftAt" IS NULL AND right(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), 10) = ${digits}
       ORDER BY "createdAt" ASC LIMIT 1`;
    contact = rows[0] ?? null;
  }
  if (!contact) return null;
  const lead = await db.lead.findFirst({ where: { contactId: contact.id, status: { notIn: [...CLOSED_LEADS] } }, select: { id: true }, orderBy: { updatedAt: "desc" } });
  return { contactId: contact.id, companyId: contact.companyId, leadId: lead?.id ?? null };
}

/** Links a conversation to the customer on file, once — never over a link a person made. */
async function linkCustomer(conversationId: string): Promise<void> {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, leadId: true, customerEmail: true, customerPhone: true } });
  if (!c || c.contactId) return;
  const found = await customerOnFile(c.customerEmail, c.customerPhone);
  if (!found) return;
  await db.conversation.update({ where: { id: conversationId }, data: { contactId: found.contactId, companyId: found.companyId, leadId: c.leadId ?? found.leadId } });
}

// ─── Leads ───────────────────────────────────────────────────────────────────────────────────────

const KIND_WORD: Record<InboxKind, string> = { WEB: "Website chat", WHATSAPP: "WhatsApp" };

export type LeadMade = { ok: true; leadId: string | null; reference: string | null; contactOnly: boolean } | { ok: false; error: string };

/**
 * A lead for this conversation's customer, through the same intake a website form uses
 * (src/lib/lead-capture/intake.ts): their company and contact found or made, the assignment rules — or
 * `ownerUserId` — deciding whose it is. A conversation that already has one keeps it. Without leads in
 * the plan, the contact is made and linked instead.
 */
export async function makeLead(conversationId: string, by: { ownerUserId: string | null; notify: boolean }): Promise<LeadMade> {
  const c = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, kind: true, leadId: true, customerName: true, customerEmail: true, customerPhone: true, pageUrl: true, channel: { select: { name: true, createdById: true } }, lead: { select: { leadSeq: true } } },
  });
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.leadId && c.lead) return { ok: true, leadId: c.leadId, reference: formatLeadId(c.lead.leadSeq), contactOnly: false };
  if (!c.customerEmail && !c.customerPhone) return { ok: false, error: "There's no phone number or email for them yet — ask for one first." };
  const kind = c.kind as InboxKind;
  const name = c.customerName?.trim() || (c.customerPhone ? `${KIND_WORD[kind]} ${c.customerPhone}` : "Website visitor");
  const firstWords = await db.conversationMessage.findMany({ where: { conversationId, author: "CUSTOMER" }, orderBy: { createdAt: "asc" }, take: 5, select: { body: true } });
  const payload: LeadPayload = {
    name: name.slice(0, 120),
    email: c.customerEmail ?? "",
    phone: (c.customerPhone ?? "").slice(0, 20),
    message: firstWords.map((m) => m.body).join("\n").slice(0, 2000),
    source: kind === "WHATSAPP" ? "WHATSAPP" : "LIVE_CHAT",
    page_url: c.pageUrl && /^https?:\/\//.test(c.pageUrl) ? c.pageUrl.slice(0, 500) : "",
  } as LeadPayload;
  const result = await intakeLead(
    { id: null, name: `${KIND_WORD[kind]} · ${c.channel.name}`, sourceLabel: c.channel.name, createdById: by.ownerUserId ?? c.channel.createdById },
    payload,
    {
      ...(by.ownerUserId ? { ownerUserId: by.ownerUserId } : {}),
      leadTitle: `${KIND_WORD[kind]} — ${name}`.slice(0, 200),
      notifyTitle: `A ${kind === "WHATSAPP" ? "WhatsApp" : "website chat"} lead was assigned to you`,
      notify: by.notify,
    },
  );
  if (result.status === "reseller") return { ok: false, error: "This customer is a reseller's, so the enquiry went to the reseller's account manager instead." };
  if (result.status === "contact") {
    await db.conversation.update({ where: { id: conversationId }, data: { contactId: result.contactId, companyId: result.companyId } });
    return { ok: true, leadId: null, reference: null, contactOnly: true };
  }
  const lead = await db.lead.findUnique({ where: { id: result.leadId }, select: { contactId: true, companyId: true } });
  await db.conversation.update({ where: { id: conversationId }, data: { leadId: result.leadId, contactId: lead?.contactId ?? undefined, companyId: lead?.companyId ?? undefined } });
  return { ok: true, leadId: result.leadId, reference: result.reference, contactOnly: false };
}

/** The channel's own rule for a new customer: a lead once there's somebody to put it on. Never throws. */
async function autoLead(conversationId: string, settings: ChannelSettings, ownerUserId: string | null): Promise<void> {
  if (!settings.autoLead) return;
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, leadId: true, customerName: true, customerEmail: true, customerPhone: true, kind: true } });
  if (!c || c.contactId || c.leadId) return;
  // A website visitor needs a name as well; a WhatsApp number comes with its profile name or stands alone.
  if (c.kind === "WEB" && (!c.customerName || (!c.customerEmail && !c.customerPhone))) return;
  if (c.kind === "WHATSAPP" && !c.customerPhone) return;
  await makeLead(conversationId, { ownerUserId, notify: true }).catch((err) => console.error("[inbox] a lead couldn't be made", err instanceof Error ? err.message : err));
}

// ─── Messages ────────────────────────────────────────────────────────────────────────────────────

async function addMessage(
  conversationId: string,
  author: ConversationAuthor,
  body: string,
  extra: { userId?: string | null; externalId?: string | null; templateName?: string | null; delivery?: ConversationDelivery | null; error?: string | null; at?: Date; media?: InboundMedia | null } = {},
) {
  return db.conversationMessage.create({
    data: {
      conversationId,
      author,
      body: body.slice(0, INBOX_LIMITS.message * 2),
      userId: extra.userId ?? null,
      externalId: extra.externalId ?? null,
      templateName: extra.templateName ?? null,
      delivery: extra.delivery ?? null,
      error: extra.error ?? null,
      ...(extra.media ? { mediaId: extra.media.id, mediaMime: extra.media.mime, mediaName: extra.media.name } : {}),
      ...(extra.at ? { createdAt: extra.at } : {}),
    },
    select: { id: true, createdAt: true },
  });
}

// ─── Workflows, office hours, round-robin ────────────────────────────────────────────────────────

/** For Deskzo Automate: a conversation started, or needs a person (src/lib/automate/triggers.ts). Never throws. */
async function emitConversation(type: "conversation.started" | "conversation.needs_person", conversationId: string): Promise<void> {
  try {
    const c = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, seq: true, kind: true, customerName: true, customerPhone: true, customerEmail: true, pageUrl: true, assignedToUserId: true, companyId: true, contactId: true, leadId: true, channel: { select: { id: true, name: true } } },
    });
    if (!c) return;
    const first = await db.conversationMessage.findFirst({ where: { conversationId, author: "CUSTOMER" }, orderBy: { createdAt: "asc" }, select: { body: true } });
    await db.$transaction((tx) =>
      emitEvent(tx, {
        type,
        recordType: "conversation",
        recordId: c.id,
        payload: {
          conversation: {
            id: c.id,
            ref: conversationRef(c.seq),
            channel: c.channel.name,
            channelId: c.channel.id,
            kind: c.kind,
            customerName: c.customerName,
            customerPhone: c.customerPhone,
            customerEmail: c.customerEmail,
            firstMessage: first?.body.slice(0, 500) ?? null,
            pageUrl: c.pageUrl,
            assignedToUserId: c.assignedToUserId,
          },
          companyId: c.companyId,
          contactId: c.contactId,
          leadId: c.leadId,
        },
      }),
    );
  } catch (err) {
    console.error(`[inbox] the ${type} event wasn't recorded`, err instanceof Error ? err.message : err);
  }
}

/** Whether the channel's team is in now, by its office hours and the workspace's clock. */
async function teamIn(settings: ChannelSettings, now: Date): Promise<boolean> {
  if (!settings.hours.on) return true;
  return withinHours(settings.hours, (await workspaceClock()).parts(now));
}

const AWAY_EVERY_MS = 12 * 60 * 60 * 1000;

/**
 * The next person in turn for a shared channel set to round-robin: after whoever was given the last one,
 * among the channel's people (or everybody who answers), skipping anybody switched off or without the
 * inbox. Null when there's nobody.
 */
async function nextInTurn(channel: { id: string; lastAssignedUserId: string | null }, settings: ChannelSettings): Promise<string | null> {
  const named = settings.assign.people;
  const candidates = await db.user.findMany({ where: { active: true, ...(named.length ? { id: { in: named } } : {}) }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  const ordered = named.length ? named.map((id) => candidates.find((u) => u.id === id)).filter((u): u is { id: string; name: string } => !!u) : candidates;
  const eligible: string[] = [];
  for (const u of ordered) if (await can(u.id, "inbox.view")) eligible.push(u.id);
  if (!eligible.length) return null;
  const after = channel.lastAssignedUserId ? eligible.indexOf(channel.lastAssignedUserId) : -1;
  return eligible[(after + 1) % eligible.length]!;
}

/** Gives an unassigned conversation on a round-robin channel to whoever's turn it is, and tells them. */
async function assignInTurn(conversationId: string, channel: InboxChannel, settings: ChannelSettings): Promise<void> {
  if (settings.assign.mode !== "rotate" || channel.ownerUserId) return;
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { seq: true, assignedToUserId: true, customerName: true, customerPhone: true } });
  if (!c || c.assignedToUserId) return;
  const fresh = await db.inboxChannel.findUnique({ where: { id: channel.id }, select: { id: true, lastAssignedUserId: true } });
  const next = fresh ? await nextInTurn(fresh, settings) : null;
  if (!next) return;
  // Only if nobody took it meanwhile, and the turn moves on with it.
  const taken = await db.conversation.updateMany({ where: { id: conversationId, assignedToUserId: null }, data: { assignedToUserId: next } });
  if (!taken.count) return;
  await db.inboxChannel.update({ where: { id: channel.id }, data: { lastAssignedUserId: next } });
  const person = await db.user.findUnique({ where: { id: next }, select: { name: true } });
  await addMessage(conversationId, "SYSTEM", `Given to ${person?.name ?? "the next person"} in turn`);
  await notifyUser({
    userId: next,
    type: "INBOX_MESSAGE",
    title: `It's your turn: ${c.customerName || c.customerPhone || "a website visitor"} needs a person`,
    message: conversationRef(c.seq),
    link: `/inbox?c=${conversationRef(c.seq)}`,
  });
}

/** The workspace's name, for the AI to say who it speaks for. */
async function businessName(): Promise<string> {
  try {
    return (await currentTenant()).name || "the business";
  } catch {
    return "the business";
  }
}

/** Sends the bot's words: on WhatsApp through Meta, then kept; on a website, kept for the bubble to fetch. */
async function botSays(conversation: { id: string; kind: InboxKind; waId: string | null }, channel: Pick<InboxChannel, "phoneNumberId">, text: string): Promise<void> {
  if (conversation.kind === "WHATSAPP") {
    const sent = channel.phoneNumberId && conversation.waId ? await sendWhatsApp({ phoneNumberId: channel.phoneNumberId, to: conversation.waId, text }) : { ok: false as const, error: "No number to send from." };
    await addMessage(conversation.id, "BOT", text, sent.ok ? { externalId: sent.id, delivery: "SENT" } : { delivery: "FAILED", error: sent.error });
    return;
  }
  await addMessage(conversation.id, "BOT", text);
}

/**
 * After a customer's message is kept: the conversation reopens and moves up, the customer is linked to
 * what's on file, the bot takes its turn while it has the conversation (Deskzo AI answering what the set
 * answers don't, where the channel lets it), a lead is made where the channel says so, and — once the
 * customer needs a person — they're told if the team is out, it goes to whoever's turn it is, and the
 * workflows hear of it. Whoever needs telling is told.
 */
async function afterCustomerMessage(conversationId: string, text: string, at: Date, opts: { first: boolean; externalId?: string | null }): Promise<void> {
  const previous = await db.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { lastCustomerAt: true } });
  await db.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at, lastCustomerAt: at, status: "OPEN", closedAt: null } });
  await linkCustomer(conversationId);

  const c = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { id: true, kind: true, waId: true, botActive: true, botState: true, customerName: true, customerEmail: true, customerPhone: true, assignedToUserId: true, awayNoticeAt: true, channel: true },
  });
  const settings = channelSettings(c.channel.settings, c.kind as InboxKind);
  const kind = c.kind as InboxKind;
  const now = new Date();
  // A conversation that starts without the bot needs a person from its first message; one with it, once it hands over.
  let needsPerson = opts.first && !(c.botActive && settings.bot.on);
  let botStillOn = false;

  if (c.botActive && settings.bot.on) {
    const known: Known = { name: c.customerName, email: c.customerEmail, phone: c.customerPhone };
    const priorState = (c.botState as BotState | null) ?? null;
    // The conversation and how far into it choose the bot's words, so it never says the same line twice running.
    const seed = `${c.id}:${await db.conversationMessage.count({ where: { conversationId: c.id } })}`;
    let turn = botReply({ text, settings, state: priorState, known, kind, seed });
    // No set answer fitted: Deskzo AI answers instead where the channel lets it, and hands over when it can't.
    if (turn.reason === "unknown" && settings.bot.ai.on) {
      const recent = await db.conversationMessage.findMany({ where: { conversationId: c.id }, orderBy: { createdAt: "desc" }, take: 12, select: { author: true, body: true } });
      const ai = await aiAnswer({ settings, business: await businessName(), messages: recent.reverse(), customerFirstName: firstNameOf(c.customerName) });
      if ("text" in ai) turn = { replies: [ai.text], state: { step: "chatting", answered: priorState?.answered ?? 0 }, handover: false, learned: turn.learned, reason: "answer" };
    }
    needsPerson = needsPerson || turn.handover;
    botStillOn = !turn.handover;
    // The first WhatsApp message gets the greeting first: a website visitor saw it in the bubble already.
    const replies = opts.first && kind === "WHATSAPP" && botGreeting(settings) ? [botGreeting(settings)!, ...turn.replies] : turn.replies;
    // On WhatsApp the bot reads the message (blue ticks), shows "typing…" and takes a moment, as a person would —
    // at most six seconds in all, so the webhook still answers Meta in good time. The website bubble paces itself.
    let paced = 0;
    for (const reply of replies) {
      if (kind === "WHATSAPP" && opts.externalId && c.channel.phoneNumberId) {
        await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: opts.externalId, typing: true });
        const wait = Math.min(typingMs(reply), Math.max(0, 6_000 - paced));
        paced += wait;
        await pause(wait);
      }
      await botSays({ id: c.id, kind, waId: c.waId }, c.channel, reply);
    }
    await db.conversation.update({
      where: { id: c.id },
      data: {
        botState: turn.state as Prisma.InputJsonValue,
        botActive: !turn.handover,
        lastMessageAt: new Date(),
        ...(turn.learned.name && !c.customerName ? { customerName: turn.learned.name.slice(0, INBOX_LIMITS.name) } : {}),
        ...(turn.learned.email && !c.customerEmail ? { customerEmail: turn.learned.email.slice(0, 200) } : {}),
        ...(turn.learned.phone && !c.customerPhone ? { customerPhone: turn.learned.phone.slice(0, 20) } : {}),
      },
    });
    if (turn.learned.email || turn.learned.phone) await linkCustomer(c.id);
  }

  await autoLead(c.id, settings, c.channel.ownerUserId);

  // Waiting on a person outside office hours, with nobody from the team in the last half hour: told when
  // they'll hear back — once in twelve hours, not every message.
  if (!botStillOn && !(await teamIn(settings, now)) && (!c.awayNoticeAt || now.getTime() - c.awayNoticeAt.getTime() > AWAY_EVERY_MS)) {
    const recentReply = await db.conversationMessage.findFirst({ where: { conversationId: c.id, author: "AGENT", createdAt: { gt: new Date(now.getTime() - 30 * 60_000) } }, select: { id: true } });
    if (!recentReply) {
      const known = await db.conversation.findUnique({ where: { id: c.id }, select: { customerName: true } });
      await botSays({ id: c.id, kind, waId: c.waId }, c.channel, withName(settings.hours.away, firstNameOf(known?.customerName)));
      await db.conversation.update({ where: { id: c.id }, data: { awayNoticeAt: now } });
    }
  }

  let justAssigned = false;
  if (needsPerson) {
    // When response times start (src/lib/inbox/report.ts). Written on its own: a workspace not migrated yet
    // loses only this, never the message.
    await db.conversation.updateMany({ where: { id: c.id, needsPersonAt: null }, data: { needsPersonAt: at } }).catch(() => {});
    const before = c.assignedToUserId;
    await assignInTurn(c.id, c.channel, settings);
    justAssigned = !before && !!(await db.conversation.findUnique({ where: { id: c.id }, select: { assignedToUserId: true } }))?.assignedToUserId;
  }
  if (opts.first) await emitConversation("conversation.started", c.id);
  if (needsPerson) await emitConversation("conversation.needs_person", c.id);

  // Told: a rep, of a new conversation on their own number; whoever it's assigned to, when it wasn't waiting on them already.
  const ref = await db.conversation.findUniqueOrThrow({ where: { id: c.id }, select: { seq: true, customerName: true, customerPhone: true, assignedToUserId: true } });
  const who = ref.customerName || ref.customerPhone || "A website visitor";
  const link = `/inbox?c=${conversationRef(ref.seq)}`;
  const tell = new Set<string>();
  if (opts.first && c.channel.ownerUserId) tell.add(c.channel.ownerUserId);
  if (ref.assignedToUserId && !opts.first && !justAssigned) {
    const read = await db.conversationRead.findUnique({ where: { conversationId_userId: { conversationId: c.id, userId: ref.assignedToUserId } }, select: { readAt: true } });
    if (!previous.lastCustomerAt || !read || read.readAt >= previous.lastCustomerAt) tell.add(ref.assignedToUserId);
  }
  for (const userId of tell) {
    await notifyUser({ userId, type: "INBOX_MESSAGE", title: `${who} wrote on ${KIND_WORD[kind]}`, message: conversationRef(ref.seq), link });
  }
  await announce(c.id);
}

// ─── A website's bubble ──────────────────────────────────────────────────────────────────────────

export type WebMessage = { id: string; from: "you" | "bot" | "agent"; name: string | null; body: string; at: string };

/** A website channel by its public key, while it's switched on. */
export async function webChannel(publicKey: string) {
  if (!publicKey || publicKey.length > 64) return null;
  return db.inboxChannel.findFirst({ where: { publicKey, kind: "WEB", active: true } });
}

/** The visitor's conversation on this channel, by the token their browser keeps. */
async function visitorConversation(channelId: string, token: string | null | undefined) {
  if (!token || token.length < 20 || token.length > 100) return null;
  return db.conversation.findFirst({ where: { visitorTokenHash: sha256(token), channelId }, select: { id: true } });
}

/** A website visitor's message: their conversation found by token, or a new one (and a token for it). */
export async function receiveWebMessage(
  channel: InboxChannel,
  input: { token?: string | null; text: string; name?: string | null; email?: string | null; pageUrl?: string | null },
): Promise<{ token: string; conversationId: string }> {
  const text = input.text.replace(/\r\n?/g, "\n").trim().slice(0, INBOX_LIMITS.message);
  const settings = channelSettings(channel.settings, "WEB");
  const now = new Date();
  let token = input.token ?? null;
  let existing = await visitorConversation(channel.id, token);
  let first = false;
  if (!existing) {
    token = randomBytes(24).toString("base64url");
    const created = await db.conversation.create({
      data: {
        channelId: channel.id,
        kind: "WEB",
        visitorTokenHash: sha256(token),
        botActive: settings.bot.on,
        customerName: input.name?.trim().slice(0, INBOX_LIMITS.name) || null,
        customerEmail: input.email?.trim().toLowerCase().slice(0, 200) || null,
        pageUrl: input.pageUrl?.slice(0, 500) || null,
        lastMessageAt: now,
      },
      select: { id: true },
    });
    const greeting = botGreeting(settings);
    if (greeting) await addMessage(created.id, "BOT", greeting, { at: new Date(now.getTime() - 1) });
    existing = created;
    first = true;
  }
  const filter = await activeWordFilter("TICKETS");
  await addMessage(existing.id, "CUSTOMER", filter ? filter.mask(text) : text, { at: now });
  await afterCustomerMessage(existing.id, text, now, { first });
  return { token: token!, conversationId: existing.id };
}

/** What the bubble shows: the conversation's messages after `after`, without staff's notes to each other. */
export async function webMessages(channelId: string, token: string, after?: string | null): Promise<WebMessage[] | null> {
  const c = await visitorConversation(channelId, token);
  if (!c) return null;
  const since = after ? new Date(after) : null;
  const [rows, channel] = await Promise.all([
    db.conversationMessage.findMany({
      where: { conversationId: c.id, author: { not: "SYSTEM" }, ...(since && !Number.isNaN(since.getTime()) ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, author: true, body: true, createdAt: true, user: { select: { name: true } } },
    }),
    db.inboxChannel.findUnique({ where: { id: channelId }, select: { settings: true } }),
  ]);
  const assistant = channelSettings(channel?.settings, "WEB").bot.name.trim() || null;
  return rows.map((m) => ({
    id: m.id,
    from: m.author === "CUSTOMER" ? "you" : m.author === "BOT" ? "bot" : "agent",
    // A first name only: a visitor learns who is helping them, not the whole team's names. The assistant by its own.
    name: m.author === "AGENT" ? (m.user?.name?.split(/\s+/)[0] ?? null) : m.author === "BOT" ? assistant : null,
    body: m.body,
    at: m.createdAt.toISOString(),
  }));
}

/**
 * What the bubble shows besides the messages, as a chat app does: whoever on the team is typing, and
 * whether the visitor's last message has been seen by somebody on the team.
 */
export async function webPresence(channelId: string, token: string): Promise<{ typing: string | null; seen: boolean } | null> {
  const c = await visitorConversation(channelId, token);
  if (!c) return null;
  const row = await db.conversation.findUnique({ where: { id: c.id }, select: { lastCustomerAt: true, reads: { orderBy: { readAt: "desc" }, take: 1, select: { readAt: true } } } });
  const lastRead = row?.reads[0]?.readAt ?? null;
  return { typing: typingIn(c.id), seen: !!row?.lastCustomerAt && !!lastRead && lastRead >= row.lastCustomerAt };
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────────────────────────

/** One message from Meta's webhook. Meta retries, so one already kept is skipped. */
export async function receiveWhatsApp(m: InboundWhatsApp): Promise<"stored" | "duplicate" | "no-channel"> {
  const channel = await db.inboxChannel.findFirst({ where: { phoneNumberId: m.phoneNumberId, kind: "WHATSAPP", active: true } });
  if (!channel) return "no-channel";
  if (await db.conversationMessage.findUnique({ where: { externalId: m.id }, select: { id: true } })) return "duplicate";
  const settings = channelSettings(channel.settings, "WHATSAPP");
  let c = await db.conversation.findFirst({ where: { channelId: channel.id, waId: m.from }, orderBy: { lastMessageAt: "desc" }, select: { id: true, status: true } });
  let first = false;
  if (!c) {
    c = await db.conversation.create({
      data: {
        channelId: channel.id,
        kind: "WHATSAPP",
        waId: m.from,
        customerPhone: `+${m.from}`,
        customerName: m.profileName?.slice(0, INBOX_LIMITS.name) || null,
        botActive: settings.bot.on,
        // A rep's own number: theirs from the start.
        assignedToUserId: channel.ownerUserId,
        lastMessageAt: m.at,
      },
      select: { id: true, status: true },
    });
    first = true;
  }
  const filter = await activeWordFilter("TICKETS");
  try {
    await addMessage(c.id, "CUSTOMER", filter ? filter.mask(m.text) : m.text, { externalId: m.id, at: m.at, media: m.media ?? null });
  } catch (err) {
    // Two deliveries of the same message at once: the other one kept it.
    if ((err as { code?: string }).code === "P2002") return "duplicate";
    throw err;
  }
  await afterCustomerMessage(c.id, m.text, m.at, { first, externalId: m.id });
  return "stored";
}

const RANK: Record<WhatsAppStatus["status"], number> = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

/** A receipt for one of ours: it only moves forward (read never goes back to delivered). */
export async function applyWhatsAppStatus(st: WhatsAppStatus): Promise<void> {
  const row = await db.conversationMessage.findUnique({ where: { externalId: st.id }, select: { id: true, delivery: true, conversationId: true } });
  if (!row) return;
  if (row.delivery && RANK[row.delivery] >= RANK[st.status]) return;
  await db.conversationMessage.update({ where: { id: row.id }, data: { delivery: st.status, ...(st.error ? { error: st.error.slice(0, 300) } : {}) } });
  await announce(row.conversationId);
}

// ─── Staff ───────────────────────────────────────────────────────────────────────────────────────

/** The conversation, if this person may see it — with what the actions below need. */
async function visibleConversation(viewer: InboxViewer, id: string) {
  const c = await db.conversation.findUnique({
    where: { id },
    select: { id: true, seq: true, kind: true, status: true, waId: true, assignedToUserId: true, lastCustomerAt: true, firstResponseAt: true, companyId: true, contactId: true, ticketId: true, channel: true },
  });
  return c && mayRead(viewer, c) ? c : null;
}

/** The conversation's id from what a page or link names: its id, or CNV-000123. */
export async function conversationIdFrom(ref: string): Promise<string | null> {
  const m = /^CNV-(\d{1,9})$/i.exec(ref.trim());
  if (!m) return ref.trim() || null;
  return (await db.conversation.findUnique({ where: { seq: Number(m[1]) }, select: { id: true } }))?.id ?? null;
}

export type StaffResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

async function markRead(conversationId: string, userId: string, at = new Date()) {
  await db.conversationRead.upsert({ where: { conversationId_userId: { conversationId, userId } }, create: { conversationId, userId, readAt: at }, update: { readAt: at } });
}

/** Words the workspace keeps from customers (the word filter's tickets list), in a staff member's reply. */
async function refusedWords(text: string): Promise<string | null> {
  const filter = await activeWordFilter("TICKETS");
  const found = filter ? [...new Set(filter.find(text))] : [];
  if (!found.length) return null;
  return `Your company doesn't allow ${found.length === 1 ? "this word" : "these words"} with customers: ${found.slice(0, 5).map((w) => `"${w}"`).join(", ")}. Change ${found.length === 1 ? "it" : "them"} and send it again.`;
}

/** After a staff member's message: the bot is done, the first response is timed, and it's theirs if nobody's. */
async function afterStaffMessage(viewer: InboxViewer, c: { id: string; assignedToUserId: string | null; firstResponseAt: Date | null }) {
  const now = new Date();
  await db.conversation.update({
    where: { id: c.id },
    data: { botActive: false, lastMessageAt: now, ...(c.firstResponseAt ? {} : { firstResponseAt: now }), ...(c.assignedToUserId ? {} : { assignedToUserId: viewer.id }) },
  });
  await markRead(c.id, viewer.id, now);
  await announce(c.id);
}

/** A staff member's reply: on WhatsApp within the 24 hours since the customer last wrote; on a website, any time. */
export async function staffReply(viewer: InboxViewer, id: string, raw: string): Promise<StaffResult> {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > INBOX_LIMITS.message) return { ok: false, error: `Keep it under ${INBOX_LIMITS.message.toLocaleString("en-IN")} characters.` };
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const words = await refusedWords(text);
  if (words) return { ok: false, error: words };
  if (c.kind === "WHATSAPP") {
    if (!whatsappWindowOpen(c.lastCustomerAt)) return { ok: false, error: "It's over 24 hours since they last wrote, so WhatsApp only allows an approved template now." };
    if (!c.channel.phoneNumberId || !c.waId) return { ok: false, error: "This number can't send." };
    const sent = await sendWhatsApp({ phoneNumberId: c.channel.phoneNumberId, to: c.waId, text });
    if (!sent.ok) return { ok: false, error: sent.error };
    await addMessage(c.id, "AGENT", text, { userId: viewer.id, externalId: sent.id, delivery: "SENT" });
  } else {
    await addMessage(c.id, "AGENT", text, { userId: viewer.id });
  }
  await afterStaffMessage(viewer, c);
  return { ok: true, data: null };
}

/**
 * A staff member is typing a reply: the website bubble shows "<first name> is typing…" for a few seconds,
 * and on WhatsApp the customer sees "typing…" (asked of Meta no more than every twenty seconds).
 */
export async function staffTyping(viewer: InboxViewer, id: string, now = Date.now()): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const state = typingState();
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  const typing = { id: c.id, name: firstNameOf(me?.name) ?? "Somebody", until: now + TYPING_MS };
  state.typing.set(c.id, { name: typing.name, until: typing.until });
  broadcast("inbox:typing", typing);
  if (c.kind === "WHATSAPP" && c.channel.phoneNumberId && whatsappWindowOpen(c.lastCustomerAt) && now - (state.whatsappAt.get(c.id) ?? 0) > WHATSAPP_TYPING_EVERY_MS) {
    const last = await db.conversationMessage.findFirst({ where: { conversationId: c.id, author: "CUSTOMER", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select: { externalId: true } });
    if (last?.externalId) {
      state.whatsappAt.set(c.id, now);
      await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: last.externalId, typing: true });
    }
  }
  return { ok: true, data: null };
}

/**
 * A WhatsApp customer's messages, read by somebody on the team: Meta is told, so they see the blue ticks a
 * person on the phone would give them. The newest unread one is enough — WhatsApp marks the ones before it.
 */
async function sendReadReceipt(conversationId: string): Promise<void> {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true, channel: { select: { phoneNumberId: true } } } });
  if (c?.kind !== "WHATSAPP" || !c.channel.phoneNumberId) return;
  const last = await db.conversationMessage.findFirst({ where: { conversationId, author: "CUSTOMER", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true, externalId: true, delivery: true } });
  if (!last?.externalId || last.delivery === "READ") return;
  if (await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: last.externalId, typing: false })) {
    await db.conversationMessage.update({ where: { id: last.id }, data: { delivery: "READ" } });
  }
}

/** An approved WhatsApp template — the one way to write once the 24 hours are up. */
export async function staffTemplate(viewer: InboxViewer, id: string, input: { name: string; variables: string[] }): Promise<StaffResult> {
  const name = input.name.trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: "Give the template's name as Meta has it: lower case, digits and underscores." };
  const variables = input.variables.map((v) => v.trim());
  if (variables.length > 10) return { ok: false, error: "A template takes at most ten values here." };
  if (variables.some((v) => !v || v.length > 500)) return { ok: false, error: "Fill in every value — WhatsApp drops blanks and shifts the rest." };
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.kind !== "WHATSAPP" || !c.channel.phoneNumberId || !c.waId) return { ok: false, error: "Templates are for WhatsApp." };
  const words = await refusedWords(variables.join("\n"));
  if (words) return { ok: false, error: words };
  const sent = await sendWhatsApp({ phoneNumberId: c.channel.phoneNumberId, to: c.waId, template: { name, variables } });
  if (!sent.ok) return { ok: false, error: sent.error };
  await addMessage(c.id, "AGENT", `Template “${name}”${variables.length ? `: ${variables.join(" · ")}` : ""}`, { userId: viewer.id, templateName: name, externalId: sent.id, delivery: "SENT" });
  await afterStaffMessage(viewer, c);
  return { ok: true, data: null };
}

/** Whether this person may be given a conversation on this channel. */
async function mayTake(userId: string, channel: { ownerUserId: string | null }): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
  if (!user?.active || !(await can(userId, "inbox.view"))) return false;
  return channel.ownerUserId === null || channel.ownerUserId === userId || (await can(userId, "inbox.viewAll"));
}

export async function assignConversation(viewer: InboxViewer, id: string, toUserId: string | null): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (toUserId === c.assignedToUserId) return { ok: true, data: null };
  if (toUserId && !(await mayTake(toUserId, c.channel))) return { ok: false, error: "They can't take customer conversations here." };
  const [me, them] = await Promise.all([
    db.user.findUnique({ where: { id: viewer.id }, select: { name: true } }),
    toUserId ? db.user.findUnique({ where: { id: toUserId }, select: { name: true } }) : null,
  ]);
  await db.conversation.update({ where: { id: c.id }, data: { assignedToUserId: toUserId } });
  await addMessage(c.id, "SYSTEM", toUserId ? (toUserId === viewer.id ? `${me?.name ?? "Somebody"} took it` : `${me?.name ?? "Somebody"} gave it to ${them?.name ?? "somebody"}`) : `${me?.name ?? "Somebody"} put it back in the queue`, { userId: viewer.id });
  if (toUserId && toUserId !== viewer.id) {
    await notifyUser({ userId: toUserId, type: "INBOX_MESSAGE", title: `${me?.name ?? "Somebody"} gave you a customer conversation`, message: conversationRef(c.seq), link: `/inbox?c=${conversationRef(c.seq)}` });
  }
  await announce(c.id);
  return { ok: true, data: null };
}

export async function setConversationStatus(viewer: InboxViewer, id: string, status: "OPEN" | "CLOSED"): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.status === status) return { ok: true, data: null };
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  await db.conversation.update({ where: { id: c.id }, data: { status, closedAt: status === "CLOSED" ? new Date() : null, ...(status === "CLOSED" ? { botActive: false } : {}) } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} ${status === "CLOSED" ? "closed it" : "reopened it"}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: null };
}

/** A lead from the conversation, given to whoever has it (or the person asking). */
export async function staffMakeLead(viewer: InboxViewer, id: string): Promise<LeadMade> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const owner = c.assignedToUserId ?? viewer.id;
  const made = await makeLead(c.id, { ownerUserId: owner, notify: owner !== viewer.id });
  if (made.ok) {
    await addMessage(c.id, "SYSTEM", made.contactOnly ? "Saved as a contact" : `Lead ${made.reference} made`, { userId: viewer.id });
    await announce(c.id);
  }
  return made;
}

/** A helpdesk ticket from the conversation, with what was said in it — on the company it's linked to. */
export async function staffMakeTicket(viewer: InboxViewer, id: string, rawTitle: string): Promise<StaffResult<{ ticketSeq: number }>> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.ticketId) return { ok: false, error: "It's a ticket already." };
  if (!c.companyId) return { ok: false, error: "Link it to a customer first — make a lead, or it links itself when their email or number is on file." };
  const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, INBOX_LIMITS.ticketTitle);
  if (title.length < 2) return { ok: false, error: "Give the ticket a title." };
  const said = await db.conversationMessage.findMany({ where: { conversationId: c.id, author: { not: "SYSTEM" } }, orderBy: { createdAt: "desc" }, take: 30, select: { author: true, body: true, createdAt: true } });
  const description = [`From ${conversationRef(c.seq)} (${KIND_WORD[c.kind as InboxKind]}):`, "", ...said.reverse().map((m) => `${m.author === "CUSTOMER" ? "Customer" : m.author === "BOT" ? "Bot" : "Us"}: ${m.body}`)].join("\n").slice(0, 8000);
  const data = { companyId: c.companyId, contactId: c.contactId ?? "", companyProductId: "", title, description, ticketType: "PRODUCT_SUPPORT" as const, priority: "MEDIUM" as const, assignedToUserId: "" };
  const refused = await newTicketRefusal(viewer.id, data);
  if (refused) return { ok: false, error: refused };
  const ticket = await db.$transaction((tx) => writeTicket(tx, viewer.id, data, "inbox"));
  await db.conversation.update({ where: { id: c.id }, data: { ticketId: ticket.id } });
  await addMessage(c.id, "SYSTEM", `Ticket made: ${title}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: { ticketSeq: ticket.ticketSeq } };
}

// ─── Lists ───────────────────────────────────────────────────────────────────────────────────────

export type InboxView = "mine" | "unassigned" | "open" | "closed";

export type InboxRow = {
  id: string;
  ref: string;
  kind: InboxKind;
  channelName: string;
  status: "OPEN" | "CLOSED";
  customer: string;
  preview: string;
  lastFrom: ConversationAuthor | null;
  lastMessageAt: string;
  assignedTo: { id: string; name: string } | null;
  unread: boolean;
  botActive: boolean;
};

const customerLabel = (c: { customerName: string | null; customerPhone: string | null; customerEmail: string | null; kind: string }) =>
  c.customerName || c.customerPhone || c.customerEmail || (c.kind === "WEB" ? "Website visitor" : "WhatsApp customer");

export async function listConversations(viewer: InboxViewer, filter: { view: InboxView; channelId?: string | null; q?: string | null }): Promise<InboxRow[]> {
  const view: Prisma.ConversationWhereInput =
    filter.view === "mine"
      ? { status: "OPEN", assignedToUserId: viewer.id }
      : filter.view === "unassigned"
        ? { status: "OPEN", assignedToUserId: null }
        : filter.view === "closed"
          ? { status: "CLOSED" }
          : { status: "OPEN" };
  const q = filter.q?.replace(/\s+/g, " ").trim().slice(0, 80);
  const rows = await db.conversation.findMany({
    where: {
      AND: [
        visibleWhere(viewer),
        view,
        ...(filter.channelId ? [{ channelId: filter.channelId }] : []),
        ...(q ? [{ OR: [{ customerName: { contains: q, mode: "insensitive" as const } }, { customerPhone: { contains: q } }, { customerEmail: { contains: q, mode: "insensitive" as const } }] }] : []),
      ],
    },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      lastMessageAt: true,
      lastCustomerAt: true,
      botActive: true,
      channel: { select: { name: true } },
      assignedTo: { select: { id: true, name: true } },
      messages: { where: { author: { not: "SYSTEM" } }, orderBy: { createdAt: "desc" }, take: 1, select: { body: true, author: true } },
      reads: { where: { userId: viewer.id }, select: { readAt: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id,
    ref: conversationRef(c.seq),
    kind: c.kind as InboxKind,
    channelName: c.channel.name,
    status: c.status,
    customer: customerLabel(c),
    preview: (c.messages[0]?.body ?? "").slice(0, 140),
    lastFrom: c.messages[0]?.author ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    assignedTo: c.assignedTo,
    unread: !!c.lastCustomerAt && (!c.reads[0] || c.reads[0].readAt < c.lastCustomerAt),
    botActive: c.botActive,
  }));
}

/** Open conversations waiting on this person: theirs, or nobody's, with something unread from the customer. */
export async function unreadCount(viewer: InboxViewer): Promise<number> {
  const rows = await db.conversation.findMany({
    where: { AND: [visibleWhere(viewer), { status: "OPEN", botActive: false, lastCustomerAt: { not: null }, OR: [{ assignedToUserId: viewer.id }, { assignedToUserId: null }] }] },
    select: { lastCustomerAt: true, reads: { where: { userId: viewer.id }, select: { readAt: true } } },
    take: 500,
  });
  return rows.filter((c) => !c.reads[0] || c.reads[0].readAt < c.lastCustomerAt!).length;
}

export type InboxMessage = {
  id: string;
  author: ConversationAuthor;
  userName: string | null;
  body: string;
  templateName: string | null;
  delivery: ConversationDelivery | null;
  error: string | null;
  at: string;
  /** A file the customer sent, opened through /api/inbox/files/<message id>. */
  media: { mime: string | null; name: string | null } | null;
};

export type InboxDetail = InboxRow & {
  channel: { id: string; kind: InboxKind; name: string; displayPhone: string | null; shared: boolean; assistantName: string | null };
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  pageUrl: string | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string; companySeq: number } | null;
  lead: { id: string; reference: string } | null;
  ticket: { id: string; ticketSeq: number } | null;
  /** WhatsApp: free text may go now; after 24 hours only a template. Always true on a website. */
  windowOpen: boolean;
  firstResponseAt: string | null;
  createdAt: string;
  messages: InboxMessage[];
};

/** One conversation, read — and marked read for this person. */
export async function conversationDetail(viewer: InboxViewer, id: string): Promise<InboxDetail | null> {
  const c = await db.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      pageUrl: true,
      lastMessageAt: true,
      lastCustomerAt: true,
      firstResponseAt: true,
      createdAt: true,
      botActive: true,
      assignedToUserId: true,
      channel: { select: { id: true, kind: true, name: true, displayPhone: true, ownerUserId: true, settings: true } },
      assignedTo: { select: { id: true, name: true } },
      contact: { select: { id: true, name: true } },
      company: { select: { id: true, name: true, companySeq: true } },
      lead: { select: { id: true, leadSeq: true } },
      ticket: { select: { id: true, ticketSeq: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 300,
        select: { id: true, author: true, body: true, templateName: true, delivery: true, error: true, createdAt: true, mediaId: true, mediaMime: true, mediaName: true, user: { select: { name: true } } },
      },
    },
  });
  if (!c || !mayRead(viewer, c)) return null;
  await markRead(c.id, viewer.id);
  // The customer's blue ticks, without holding up the page.
  void sendReadReceipt(c.id).catch(() => {});
  const last = c.messages.find((m) => m.author !== "SYSTEM");
  return {
    id: c.id,
    ref: conversationRef(c.seq),
    kind: c.kind as InboxKind,
    channelName: c.channel.name,
    status: c.status,
    customer: customerLabel(c),
    preview: (last?.body ?? "").slice(0, 140),
    lastFrom: last?.author ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    assignedTo: c.assignedTo,
    unread: false,
    botActive: c.botActive,
    channel: {
      id: c.channel.id,
      kind: c.channel.kind as InboxKind,
      name: c.channel.name,
      displayPhone: c.channel.displayPhone,
      shared: c.channel.ownerUserId === null,
      assistantName: channelSettings(c.channel.settings, c.channel.kind as InboxKind).bot.name.trim() || null,
    },
    customerName: c.customerName,
    customerEmail: c.customerEmail,
    customerPhone: c.customerPhone,
    pageUrl: c.pageUrl,
    contact: c.contact,
    company: c.company,
    lead: c.lead ? { id: c.lead.id, reference: formatLeadId(c.lead.leadSeq) } : null,
    ticket: c.ticket,
    windowOpen: c.kind === "WEB" || whatsappWindowOpen(c.lastCustomerAt),
    firstResponseAt: c.firstResponseAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    messages: c.messages.reverse().map((m) => ({
      id: m.id,
      author: m.author,
      userName: m.user?.name ?? null,
      body: m.body,
      templateName: m.templateName,
      delivery: m.delivery,
      error: m.error,
      at: m.createdAt.toISOString(),
      media: m.mediaId ? { mime: m.mediaMime, name: m.mediaName } : null,
    })),
  };
}

export type InboxFile = { ok: true; bytes: Buffer; mime: string; name: string | null } | { ok: false; status: 404 | 502; error: string };

/**
 * A file a customer sent, for somebody who may read its conversation: kept here once fetched from Meta
 * (whose link lasts minutes and whose copy goes after 30 days), fetched the first time it's opened.
 */
export async function conversationFile(viewer: InboxViewer, messageId: string): Promise<InboxFile> {
  const m = await db.conversationMessage.findUnique({
    where: { id: messageId },
    select: { id: true, mediaId: true, mediaMime: true, mediaName: true, conversation: { select: { assignedToUserId: true, channel: { select: { ownerUserId: true } } } }, file: { select: { bytes: true, mime: true, name: true } } },
  });
  if (!m?.mediaId || !mayRead(viewer, m.conversation)) return { ok: false, status: 404, error: "That file isn't there, or isn't yours to see." };
  if (m.file) return { ok: true, bytes: Buffer.from(m.file.bytes), mime: m.file.mime, name: m.file.name };
  const fetched = await fetchWhatsAppMedia(m.mediaId);
  if (!fetched.ok) return { ok: false, status: 502, error: fetched.error };
  const mime = fetched.mime || m.mediaMime || "application/octet-stream";
  await db.conversationFile
    .create({ data: { messageId: m.id, mime, name: m.mediaName, size: fetched.bytes.length, bytes: new Uint8Array(fetched.bytes) } })
    .catch((err) => {
      // Opened twice at once: the other request kept it.
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
  return { ok: true, bytes: fetched.bytes, mime, name: m.mediaName };
}

/** The people a conversation on this channel could be given to — for the assign menu. */
export async function assignablePeople(): Promise<{ id: string; name: string }[]> {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 300 });
  const allowed = await Promise.all(users.map(async (u) => ((await can(u.id, "inbox.view")) ? u : null)));
  return allowed.filter((u): u is { id: string; name: string } => !!u);
}
