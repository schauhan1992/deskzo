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
