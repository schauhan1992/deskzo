"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import {
  MAX_OWN_FIELDS,
  MAX_QUESTIONS,
  MAX_SHARED_FIELDS,
  RECORD_FIELDS,
  checkField,
  isHandle,
  readFields,
  type CardField,
  type RecordFieldSetting,
} from "@/lib/cards/fields";
import { defaultTemplate, issueCards, readTemplate, type IssueOutcome } from "@/lib/cards/server";
import { captureOpen, readScan, type ScannedContact } from "@/lib/cards/events";
import { contactFromCardAddress, loadEvent, newEventCode } from "@/lib/cards/events-server";
import { recordCardContact } from "@/lib/cards/capture";
import { workspaceClock } from "@/lib/time/workspace";
import { csvRow } from "@/lib/csv";
import { formatLeadId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Deskzo Cards, for the people signed in: the holder's own card, and — for whoever holds
 * `cards.manage` — issuing cards, switching them off and designing the templates.
 *
 * A card is something the company issues, not a permission somebody holds (see the DigitalCard model):
 * holding `cards.manage` lets you issue them, and nothing here lets anybody give themselves one
 * without it.
 */

const MANAGE_REFUSED = "Only somebody who manages digital cards can do that.";

async function manager() {
  const user = await requireModuleUser("cards");
  return (await hasEffectivePermission(user.id, "cards.manage")) ? user : null;
}

function refresh() {
  revalidatePath("/cards");
  revalidatePath("/cards/manage");
}

/** A list of fields from a form, every one checked — the first that can't be used refuses the lot. */
function checkFields(input: unknown, max: number): { fields: CardField[] } | { error: string } {
  if (!Array.isArray(input)) return { fields: [] };
  if (input.length > max) return { error: `A card can carry at most ${max} of these.` };
  const fields: CardField[] = [];
  for (const raw of input) {
    const checked = checkField((raw ?? {}) as Record<string, unknown>);
    if ("error" in checked) return { error: checked.error };
    fields.push(checked.field);
  }
  return { fields };
}

// ── The holder ──────────────────────────────────────────────────────────────────────────────────────

/**
 * The holder's own choices: which record fields to hide (only those the template leaves unlocked) and
 * their own links and numbers (only where the template allows them). Their name, title, phone and
 * photo are their record's, changed where the record is.
 */
export async function updateMyCard(input: { hidden?: unknown; ownFields?: unknown }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("cards");
  const card = await db.digitalCard.findUnique({ where: { userId: user.id }, include: { template: true } });
  if (!card) return { ok: false, error: "You don't have a digital card." };
  const spec = readTemplate(card.template);

  const hideable = new Set(spec.recordFields.filter((f) => f.show && !f.locked).map((f) => f.key as string));
  const hidden = Array.isArray(input.hidden) ? [...new Set(input.hidden.filter((k): k is string => typeof k === "string" && hideable.has(k)))] : card.hidden;

  let ownFields: CardField[] = readFields(card.ownFields, MAX_OWN_FIELDS);
  if (input.ownFields !== undefined) {
    if (!spec.allowOwnFields) return { ok: false, error: "Your company's card doesn't take fields of your own." };
    const checked = checkFields(input.ownFields, MAX_OWN_FIELDS);
    if ("error" in checked) return { ok: false, error: checked.error };
    ownFields = checked.fields;
  }

  await db.digitalCard.update({
    where: { id: card.id },
    data: { hidden, ownFields: ownFields as unknown as Prisma.InputJsonValue },
  });
  refresh();
  return { ok: true, data: null };
}

/** A note on somebody who shared back — by whoever holds them now, or a card manager. */
export async function saveCardContactNote(id: string, note: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("cards");
  const contact = await db.cardContact.findUnique({ where: { id }, select: { ownerUserId: true } });
  if (!contact) return { ok: false, error: "That contact no longer exists." };
  if (contact.ownerUserId !== user.id && !(await hasEffectivePermission(user.id, "cards.manage"))) {
    return { ok: false, error: "That contact no longer exists." };
  }
  await db.cardContact.update({ where: { id }, data: { note: note.trim().slice(0, 2000) || null } });
  refresh();
  return { ok: true, data: null };
}

// ── Issuing ─────────────────────────────────────────────────────────────────────────────────────────

const issueSchema = z.object({
  /** Exactly one way of saying who. */
  userIds: z.array(z.string().min(1)).max(2000).optional(),
  departmentId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  everyone: z.literal(true).optional(),
  templateId: z.string().min(1).nullable().optional(),
});

/**
 * Cards for some people: named one by one, or everybody in a department, a branch or a role, or the
 * whole company — the people active today. Anybody who already has a live card keeps it as it is,
 * unless a template is named, which moves theirs onto it.
 */
export async function issueDigitalCards(input: unknown): Promise<ActionResult<IssueOutcome>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { userIds, departmentId, branchId, role, everyone, templateId } = parsed.data;
  if ([userIds, departmentId, branchId, role, everyone].filter((v) => v !== undefined).length !== 1) {
    return { ok: false, error: "Choose who the cards are for." };
  }

  const ids = userIds
    ? userIds
    : (
        await db.user.findMany({
          where: {
            active: true,
            kind: "MEMBER",
            ...(departmentId ? { departmentId } : {}),
            ...(branchId ? { branchId } : {}),
            ...(role ? { role } : {}),
          },
          select: { id: true },
        })
      ).map((u) => u.id);
  if (ids.length === 0) return { ok: false, error: "Nobody active matches that." };

  try {
    const outcome = await issueCards({ userIds: ids, templateId: templateId ?? null, actorId: user.id });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "DigitalCard",
      entityId: templateId ?? "default",
      entityLabel: `Digital cards: ${outcome.issued} issued, ${outcome.switchedOn} switched back on, ${outcome.moved} moved`,
    });
    refresh();
    return { ok: true, data: outcome };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The cards couldn't be issued." };
  }
}

/** Switch cards off. Their address then answers with the company's details; switching back on is one click. */
export async function switchOffCards(cardIds: string[]): Promise<ActionResult<{ count: number }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  if (!Array.isArray(cardIds) || cardIds.length === 0 || cardIds.length > 2000) return { ok: false, error: "Choose the cards to switch off." };
  const result = await db.digitalCard.updateMany({
    where: { id: { in: cardIds }, status: "ACTIVE" },
    data: { status: "OFF", switchedOffAt: new Date(), switchedOffById: user.id },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "DigitalCard", entityId: cardIds[0]!, entityLabel: `Digital cards switched off: ${result.count}` });
  refresh();
  return { ok: true, data: { count: result.count } };
}

/** A card's address, changed — the old one stops working, so it is a manager's call and says so. */
export async function changeCardHandle(cardId: string, handle: string): Promise<ActionResult<{ handle: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const next = handle.trim().toLowerCase();
  if (!isHandle(next)) return { ok: false, error: "Use 3 to 40 lower-case letters and digits, with single hyphens between." };
  try {
    await db.digitalCard.update({ where: { id: cardId }, data: { handle: next } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { ok: false, error: "Another card already has that address." };
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") return { ok: false, error: "That card no longer exists." };
    throw err;
  }
  refresh();
  return { ok: true, data: { handle: next } };
}

// ── Templates ───────────────────────────────────────────────────────────────────────────────────────

const recordKeys = RECORD_FIELDS.map((f) => f.key) as [string, ...string[]];

const templateSchema = z.object({
  id: z.string().min(1).nullable(),
  name: z.string().trim().min(1, "Give the template a name").max(60, "Keep the name under 60 characters"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour"),
  layout: z.enum(["CLASSIC", "CENTRED"]),
  showLogo: z.boolean(),
  recordFields: z
    .array(z.object({ key: z.enum(recordKeys), show: z.boolean(), locked: z.boolean() }))
    .max(RECORD_FIELDS.length)
    .refine((list) => new Set(list.map((f) => f.key)).size === list.length, "A record field is listed twice"),
  sharedFields: z.array(z.unknown()).max(MAX_SHARED_FIELDS, `At most ${MAX_SHARED_FIELDS} shared fields`),
  allowOwnFields: z.boolean(),
  shareBack: z.boolean(),
  questions: z
    .array(z.object({ id: z.string().regex(/^[a-z0-9]{1,12}$/), label: z.string().trim().min(1, "A question is empty").max(120), required: z.boolean() }))
    .max(MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions`),
});

/**
 * A template, made or changed. Every card drawn from it changes with it the moment it is saved — the
 * editor says how many before it does.
 */
export async function saveCardTemplate(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const t = parsed.data;
  const shared = checkFields(t.sharedFields, MAX_SHARED_FIELDS);
  if ("error" in shared) return { ok: false, error: shared.error };

  const data = {
    name: t.name,
    color: t.color.toLowerCase(),
    layout: t.layout,
    showLogo: t.showLogo,
    recordFields: t.recordFields as RecordFieldSetting[] as unknown as Prisma.InputJsonValue,
    sharedFields: shared.fields as unknown as Prisma.InputJsonValue,
    allowOwnFields: t.allowOwnFields,
    shareBack: t.shareBack,
    questions: t.questions as unknown as Prisma.InputJsonValue,
  };

  let id: string;
  if (t.id) {
    const updated = await db.cardTemplate.updateMany({ where: { id: t.id }, data });
    if (updated.count === 0) return { ok: false, error: "That template no longer exists." };
    id = t.id;
  } else {
    // The first template a workspace makes is its default.
    const hasDefault = (await db.cardTemplate.count({ where: { isDefault: true } })) > 0;
    id = (await db.cardTemplate.create({ data: { ...data, isDefault: !hasDefault, createdById: user.id }, select: { id: true } })).id;
  }
  await recordAudit({ userId: user.id, action: t.id ? "UPDATE" : "CREATE", entityType: "CardTemplate", entityId: id, entityLabel: t.name });
  refresh();
  return { ok: true, data: { id } };
}

/** The template new cards are drawn from. */
export async function makeDefaultCardTemplate(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const template = await db.cardTemplate.findUnique({ where: { id }, select: { id: true } });
  if (!template) return { ok: false, error: "That template no longer exists." };
  await db.$transaction(async (tx) => {
    await tx.cardTemplate.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    await tx.cardTemplate.update({ where: { id }, data: { isDefault: true } });
  });
  refresh();
  return { ok: true, data: null };
}

/** A template nobody's card uses, and that isn't the default, can go. */
export async function deleteCardTemplate(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const template = await db.cardTemplate.findUnique({ where: { id }, select: { isDefault: true, name: true, _count: { select: { cards: true } } } });
  if (!template) return { ok: false, error: "That template no longer exists." };
  if (template.isDefault) return { ok: false, error: "This is the default template. Make another the default first." };
  if (template._count.cards > 0) return { ok: false, error: `${template._count.cards} ${template._count.cards === 1 ? "card uses" : "cards use"} it. Move them to another template first.` };
  await db.cardTemplate.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "CardTemplate", entityId: id, entityLabel: template.name });
  refresh();
  return { ok: true, data: null };
}

/** The default template, made now if the workspace has none — so the editor always has one to open. */
export async function ensureDefaultCardTemplate(): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const template = await defaultTemplate(user.id);
  return { ok: true, data: { id: template.id } };
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const eventSchema = z
  .object({
    id: z.string().min(1).nullable(),
    name: z.string().trim().min(1, "Give the event a name").max(120, "Keep the name under 120 characters"),
    venue: z.string().trim().max(160, "Keep the venue under 160 characters"),
    startsOn: z.string().regex(DAY, "Choose the first day"),
    endsOn: z.string().regex(DAY, "Choose the last day"),
    goal: z.number().int().positive("A goal is a number of people").max(1_000_000).nullable(),
    cost: z.number().nonnegative("A cost can't be negative").max(1_000_000_000).nullable(),
    memberIds: z.array(z.string().min(1)).max(500),
    questions: z
      .array(z.object({ id: z.string().regex(/^[a-z0-9]{1,12}$/), label: z.string().trim().min(1, "A question is empty").max(120), required: z.boolean() }))
      .max(MAX_QUESTIONS, `At most ${MAX_QUESTIONS} questions`),
  })
  .refine((e) => e.endsOn >= e.startsOn, { message: "The last day is before the first", path: ["endsOn"] })
  .refine((e) => Date.parse(`${e.endsOn}T00:00:00Z`) - Date.parse(`${e.startsOn}T00:00:00Z`) <= 59 * 86_400_000, {
    message: "An event runs for 60 days at most",
    path: ["endsOn"],
  });

/**
 * An event the team works, made or changed. Its team are the people whose cards count towards it and
 * who may scan; only people with a live card are offered, but anybody active may be on it.
 */
export async function saveCardEvent(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const e = parsed.data;
  const members = await db.user.findMany({ where: { id: { in: [...new Set(e.memberIds)] }, active: true, kind: "MEMBER" }, select: { id: true } });
  const data = {
    name: e.name,
    venue: e.venue || null,
    startsOn: new Date(`${e.startsOn}T00:00:00Z`),
    endsOn: new Date(`${e.endsOn}T00:00:00Z`),
    goal: e.goal,
    cost: e.cost,
    questions: e.questions as unknown as Prisma.InputJsonValue,
  };

  let id: string;
  if (e.id) {
    const existing = await db.cardCampaign.findUnique({ where: { id: e.id }, select: { id: true } });
    if (!existing) return { ok: false, error: "That event no longer exists." };
    id = e.id;
    await db.$transaction(async (tx) => {
      await tx.cardCampaign.update({ where: { id }, data });
      await tx.cardCampaignMember.deleteMany({ where: { campaignId: id, userId: { notIn: members.map((m) => m.id) } } });
      await tx.cardCampaignMember.createMany({ data: members.map((m) => ({ campaignId: id, userId: m.id })), skipDuplicates: true });
    });
  } else {
    id = (
      await db.cardCampaign.create({
        data: { ...data, code: newEventCode(), createdById: user.id, members: { create: members.map((m) => ({ userId: m.id })) } },
        select: { id: true },
      })
    ).id;
  }
  await recordAudit({ userId: user.id, action: e.id ? "UPDATE" : "CREATE", entityType: "CardCampaign", entityId: id, entityLabel: e.name });
  refresh();
  revalidatePath("/cards/events");
  return { ok: true, data: { id } };
}

/** An event nobody was met at can go. One with people stays, for its numbers. */
export async function deleteCardEvent(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const event = await db.cardCampaign.findUnique({ where: { id }, select: { name: true, _count: { select: { contacts: true } } } });
  if (!event) return { ok: false, error: "That event no longer exists." };
  if (event._count.contacts > 0) return { ok: false, error: `${event._count.contacts} ${event._count.contacts === 1 ? "person was" : "people were"} met at it, so it stays with its numbers.` };
  await db.cardCampaign.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "CardCampaign", entityId: id, entityLabel: event.name });
  revalidatePath("/cards/events");
  return { ok: true, data: null };
}

/** Whether this person may add people met at this event: its team, or whoever manages cards. */
async function mayCapture(userId: string, eventId: string): Promise<{ id: string; name: string; memberIds: string[] } | string> {
  const event = await loadEvent(eventId);
  if (!event) return "That event no longer exists.";
  const member = event.memberIds.includes(userId);
  if (!member && !(await hasEffectivePermission(userId, "cards.manage"))) return "That event no longer exists.";
  const today = (await workspaceClock()).today();
  if (!captureOpen(event, today)) {
    return today < event.startsOn ? "The event hasn't started yet." : "The event ended more than a week ago, so people met there can't be added now.";
  }
  return event;
}

/**
 * What a scanned QR holds, read into a contact to check before saving: a vCard or MECARD as it is, a
 * Deskzo card's address by asking that card (see `contactFromCardAddress`), anything else as a link.
 */
export async function readScannedCode(eventId: string, raw: string): Promise<ActionResult<ScannedContact & { note: string }>> {
  const user = await requireModuleUser("cards");
  const event = await mayCapture(user.id, eventId);
  if (typeof event === "string") return { ok: false, error: event };
  const scan = readScan(String(raw ?? ""));
  const blank = { name: "", email: "", phone: "", company: "", jobTitle: "", link: "" };
  if (scan.kind === "vcard") return { ok: true, data: { ...scan.contact, note: "" } };
  if (scan.kind === "card") {
    const contact = await contactFromCardAddress(scan.host, scan.handle);
    if (contact) return { ok: true, data: { ...contact, note: "" } };
    return { ok: false, error: "That card couldn't be read — it may be switched off. Type their details in instead." };
  }
  if (scan.kind === "url") return { ok: true, data: { ...blank, link: scan.url, note: `Scanned: ${scan.url}` } };
  return { ok: false, error: "That code doesn't hold a contact or a link." };
}

const captureSchema = z.object({
  eventId: z.string().min(1),
  name: z.string().trim().min(1, "Their name, please").max(120),
  email: z.string().trim().toLowerCase().max(200).refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "That email address doesn't look right"),
  phone: z.string().trim().max(32).refine((v) => !v || /^\+?[0-9][0-9 ()-]{5,30}$/.test(v), "That phone number doesn't look right"),
  company: z.string().trim().max(160),
  jobTitle: z.string().trim().max(80),
  note: z.string().trim().max(1000),
  answers: z.record(z.string(), z.string().max(500)).optional(),
});

/**
 * Somebody one of the team met at the event, scanned or typed in: kept as theirs, and — with the CRM —
 * a lead in their name, source Event. The same person twice at one event is refused rather than doubled.
 */
export async function captureEventContact(input: unknown): Promise<ActionResult<{ leadLink: string | null }>> {
  const user = await requireModuleUser("cards");
  const parsed = captureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const c = parsed.data;
  if (!c.email && !c.phone) return { ok: false, error: "An email address or a phone number, so they can be reached." };
  const event = await mayCapture(user.id, c.eventId);
  if (typeof event === "string") return { ok: false, error: event };

  const already = await db.cardContact.findFirst({
    where: { campaignId: event.id, OR: [...(c.email ? [{ email: c.email }] : []), ...(c.phone ? [{ phone: c.phone }] : [])] },
    select: { owner: { select: { name: true } } },
  });
  if (already) return { ok: false, error: `${c.name} is already in for this event, with ${already.owner.name}.` };

  const full = await loadEvent(event.id);
  const answers = (full?.questions ?? []).flatMap((q) => {
    const answer = c.answers?.[q.id]?.trim();
    return answer ? [{ label: q.label, answer }] : [];
  });
  const [me, card] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, name: true } }),
    db.digitalCard.findUnique({ where: { userId: user.id }, select: { id: true } }),
  ]);
  const saved = await recordCardContact({
    cardId: card?.id ?? null,
    owner: me,
    via: "SCAN",
    event: { id: event.id, name: event.name },
    person: { name: c.name, email: c.email, phone: c.phone, company: c.company, jobTitle: c.jobTitle, message: c.note, answers },
  });
  revalidatePath(`/cards/events/${event.id}`);
  return { ok: true, data: { leadLink: saved.leadLink } };
}

const VIA_WORDS = { SHARE_BACK: "Shared back from a card", BOOTH: "Booth form", SCAN: "Scanned" } as const;

/** Everybody met at an event, as a CSV — for whoever manages cards. The export is recorded. */
export async function exportEventContacts(eventId: string): Promise<ActionResult<{ filename: string; csv: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGE_REFUSED };
  const event = await loadEvent(eventId);
  if (!event) return { ok: false, error: "That event no longer exists." };
  const clock = await workspaceClock();
  const rows = await db.cardContact.findMany({
    where: { campaignId: event.id },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      jobTitle: true,
      via: true,
      message: true,
      note: true,
      answers: true,
      owner: { select: { name: true } },
      card: { select: { user: { select: { name: true } } } },
      lead: { select: { leadSeq: true } },
    },
  });
  const header = ["Met", "Name", "Email", "Phone", "Company", "Job title", "How", "Met by", "Now with", "Lead", ...event.questions.map((q) => q.label), "Note from them", "Our note"];
  const lines = [csvRow(header)];
  for (const r of rows) {
    const answers = Array.isArray(r.answers) ? (r.answers as { label?: string; answer?: string }[]) : [];
    lines.push(
      csvRow([
        clock.dateTimeShort(r.createdAt),
        r.name,
        r.email ?? "",
        r.phone ?? "",
        r.company ?? "",
        r.jobTitle ?? "",
        VIA_WORDS[r.via],
        r.card?.user.name ?? r.owner.name,
        r.owner.name,
        r.lead ? formatLeadId(r.lead.leadSeq) : "",
        ...event.questions.map((q) => answers.find((a) => a.label === q.label)?.answer ?? ""),
        r.message ?? "",
        r.note ?? "",
      ]),
    );
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CardCampaign", entityId: event.id, entityLabel: `Exported ${rows.length} people met at ${event.name}` });
  const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event";
  return { ok: true, data: { filename: `${slug}-people-met-${clock.today()}.csv`, csv: lines.join("\r\n") } };
}
