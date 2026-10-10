"use server";

import QRCode from "qrcode";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { recordPermissionChange } from "@/lib/authz/audit";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { isSystemAddress } from "@/lib/people";
import type { ActionResult } from "@/actions/company";
import {
  CARD_FIELDS,
  MAX_FIELD_LENGTH,
  MAX_QUESTIONS,
  editableFields,
  permittedValues,
  readCardValues,
  readQuestions,
  readTemplateFields,
  type CardFieldKey,
  type CardLine,
  type TemplateField,
} from "@/lib/cards/template";
import {
  cardCompany,
  cardStats,
  daysAgo,
  ensureDefaultTemplate,
  issueCardsTo,
  loadCardForUser,
  switchOffCardFor,
  type CardStats,
} from "@/lib/cards/server";

/**
 * Deskzo Cards (docs/digital-cards-and-signatures.md §3): a person's own card, issuing cards, and
 * the templates they are drawn from. The public page's actions are in cards-public.ts.
 *
 * Who may do what:
 *   · `cards.use`      — have a card: "My card", its QR and link, your own fields, your contacts.
 *   · `cards.manage`   — templates, issuing and switching cards off, everybody's numbers.
 *   · `cards.viewLeads`— everybody's share-backs, not just your own.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;

async function holds(userId: string, key: "cards.use" | "cards.manage" | "cards.viewLeads") {
  return hasEffectivePermission(userId, key);
}

function cardUrl(origin: string, slug: string) {
  return `${origin}/c/${slug}`;
}

export type MyCardContact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  answers: { question: string; answer: string }[];
  leadId: string | null;
  createdAt: string;
};

export type MyCard = {
  /** Null when nobody has issued them a card yet. */
  card: {
    slug: string;
    url: string;
    qrDataUrl: string;
    active: boolean;
    templateName: string;
    accentColor: string;
    coverColor: string;
    showLogo: boolean;
    name: string;
    title: string | null;
    about: string;
    photoUrl: string | null;
    lines: CardLine[];
    /** What the template lets them change. */
    editable: {
      hideable: { key: CardFieldKey; label: string; hidden: boolean }[];
      typeable: { key: CardFieldKey; label: string; value: string; placeholder: string }[];
    };
    week: CardStats;
    allTime: CardStats;
  } | null;
  company: { name: string; logoDataUrl: string | null };
  contacts: MyCardContact[];
};

function readAnswers(raw: Prisma.JsonValue): { question: string; answer: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => (r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => r !== null && typeof r.question === "string" && typeof r.answer === "string")
    .map((r) => ({ question: String(r.question), answer: String(r.answer) }));
}

function contactRow(c: { id: string; name: string; email: string | null; phone: string | null; companyName: string | null; answers: Prisma.JsonValue; leadId: string | null; createdAt: Date }): MyCardContact {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone, companyName: c.companyName, answers: readAnswers(c.answers), leadId: c.leadId, createdAt: c.createdAt.toISOString() };
}

const PLACEHOLDERS: Partial<Record<CardFieldKey, string>> = {
  linkedin: "linkedin.com/in/your-name",
  whatsapp: "+91 98765 43210",
  calendar: "cal.com/your-name",
  mobile: "+91 98765 43210",
  website: "www.example.com",
  companyPhone: "+91 22 4000 0000",
  address: "Street, city, PIN",
};

/** "My card": the card, its QR, what they may change, its numbers, and who shared back. */
export async function getMyCard(): Promise<ActionResult<MyCard>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.use"))) return { ok: false, error: "You don't have a digital card." };
  const [loaded, company, origin] = await Promise.all([loadCardForUser(user.id), cardCompany(), tenantOrigin()]);
  if (!loaded) return { ok: true, data: { card: null, company: { name: company.name, logoDataUrl: company.logoDataUrl }, contacts: [] } };

  const [week, allTime, contacts] = await Promise.all([
    cardStats([loaded.id], daysAgo(7)),
    cardStats([loaded.id]),
    db.cardContact.findMany({ where: { cardId: loaded.id }, orderBy: { createdAt: "desc" }, take: 200 }),
  ]);
  const url = cardUrl(origin, loaded.slug);
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" });
  const { hideable, typeable } = editableFields(loaded.template.fields);
  const label = (k: CardFieldKey) => CARD_FIELDS.find((f) => f.key === k)?.label ?? k;
  const shared = new Map(loaded.template.fields.map((f) => [f.key, f.value ?? ""]));

  return {
    ok: true,
    data: {
      card: {
        slug: loaded.slug,
        url,
        qrDataUrl,
        active: loaded.offReason === null,
        templateName: loaded.template.name,
        accentColor: loaded.template.accentColor,
        coverColor: loaded.template.coverColor,
        showLogo: loaded.template.showLogo,
        name: loaded.resolved.name,
        title: loaded.resolved.title,
        about: loaded.resolved.about,
        photoUrl: loaded.resolved.showPhoto && loaded.photoVersion ? `/c/${loaded.slug}/photo?v=${loaded.photoVersion}` : null,
        lines: loaded.resolved.lines,
        editable: {
          hideable: hideable.map((k) => ({ key: k, label: label(k), hidden: loaded.values.hidden.includes(k) })),
          typeable: typeable.map((k) => ({
            key: k,
            label: label(k),
            value: loaded.values.own[k] ?? "",
            // An open shared field shows the company's value as the hint for what it replaces.
            placeholder: shared.get(k) || PLACEHOLDERS[k] || "",
          })),
        },
        week: week.get(loaded.id)!,
        allTime: allTime.get(loaded.id)!,
      },
      company: { name: company.name, logoDataUrl: company.logoDataUrl },
      contacts: contacts.map(contactRow),
    },
  };
}

const myCardSchema = z.object({
  own: z.record(z.string(), z.string().trim().max(MAX_FIELD_LENGTH, "Keep each field under 200 characters")),
  hidden: z.array(z.string()).max(CARD_FIELDS.length),
  about: z.string().trim().max(280, "Keep the line about you under 280 characters"),
});

/** Saves what the template lets them change; anything else in the input is dropped, not refused. */
export async function updateMyCard(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.use"))) return { ok: false, error: "You don't have a digital card." };
  const parsed = myCardSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const card = await db.digitalCard.findUnique({ where: { userId: user.id }, select: { id: true, template: { select: { fields: true } } } });
  if (!card) return { ok: false, error: "Nobody has issued you a card yet." };

  const fields = readTemplateFields(card.template.fields);
  const values = permittedValues(fields, readCardValues(parsed.data));
  await db.digitalCard.update({ where: { id: card.id }, data: { values: values as unknown as Prisma.InputJsonValue } });
  revalidatePath("/cards");
  return { ok: true, data: null };
}

// ─── The company view ────────────────────────────────────────────────────────────────────────

export type CardTemplateRow = {
  id: string;
  name: string;
  accentColor: string;
  coverColor: string;
  showLogo: boolean;
  isDefault: boolean;
  fields: TemplateField[];
  questions: string[];
  cards: number;
};

export type CardsOverviewRow = {
  userId: string;
  name: string;
  email: string;
  jobTitle: string | null;
  departmentId: string | null;
  departmentName: string | null;
  branchId: string | null;
  role: string;
  accountActive: boolean;
  card: { slug: string; active: boolean; templateId: string; switchedOffWhy: string | null; week: CardStats; allTime: CardStats; leads: number } | null;
};

export type CardsOverview = {
  mayManage: boolean;
  mayViewLeads: boolean;
  origin: string;
  rows: CardsOverviewRow[];
  templates: CardTemplateRow[];
  departments: { id: string; name: string }[];
  branches: { id: string; name: string }[];
  roles: { key: string; name: string }[];
  contacts: (MyCardContact & { cardholder: string })[];
};

/** Every person, their card if they have one and its numbers; templates; and, with cards.viewLeads, every share-back. */
export async function getCardsOverview(): Promise<ActionResult<CardsOverview>> {
  const user = await requireModuleUser("cards");
  const [mayManage, mayViewLeads] = await Promise.all([holds(user.id, "cards.manage"), holds(user.id, "cards.viewLeads")]);
  if (!mayManage && !mayViewLeads) return { ok: false, error: "You can't see the company's digital cards." };

  if (mayManage) await ensureDefaultTemplate();
  const [people, templates, departments, branches, roles, origin] = await Promise.all([
    db.user.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        active: true,
        departmentId: true,
        department: { select: { name: true } },
        branchId: true,
        employeeProfile: { select: { designation: true } },
        digitalCard: { select: { id: true, slug: true, active: true, templateId: true, switchedOffWhy: true, _count: { select: { contacts: { where: { leadId: { not: null } } } } } } },
      },
    }),
    db.cardTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }], include: { _count: { select: { cards: true } } } }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.branch.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.role.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true } }),
    tenantOrigin(),
  ]);
  // System accounts (platform support, Automation) have no face to put on a card.
  const humans = people.filter((p) => !isSystemPerson(p.email));
  const cardIds = humans.flatMap((p) => (p.digitalCard ? [p.digitalCard.id] : []));
  const [week, allTime] = await Promise.all([cardStats(cardIds, daysAgo(7)), cardStats(cardIds)]);

  const contacts = mayViewLeads
    ? await db.cardContact.findMany({
        orderBy: { createdAt: "desc" },
        take: 300,
        include: { card: { select: { user: { select: { name: true } } } } },
      })
    : [];

  return {
    ok: true,
    data: {
      mayManage,
      mayViewLeads,
      origin,
      rows: humans.map((p) => ({
        userId: p.id,
        name: p.name,
        email: p.email,
        jobTitle: p.employeeProfile?.designation ?? null,
        departmentId: p.departmentId,
        departmentName: p.department?.name ?? null,
        branchId: p.branchId,
        role: p.role,
        accountActive: p.active,
        card: p.digitalCard
          ? {
              slug: p.digitalCard.slug,
              active: p.digitalCard.active,
              templateId: p.digitalCard.templateId,
              switchedOffWhy: p.digitalCard.switchedOffWhy,
              week: week.get(p.digitalCard.id)!,
              allTime: allTime.get(p.digitalCard.id)!,
              leads: p.digitalCard._count.contacts,
            }
          : null,
      })),
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        accentColor: t.accentColor,
        coverColor: t.coverColor,
        showLogo: t.showLogo,
        isDefault: t.isDefault,
        fields: readTemplateFields(t.fields),
        questions: readQuestions(t.questions),
        cards: t._count.cards,
      })),
      departments,
      branches,
      roles,
      contacts: contacts.map((c) => ({ ...contactRow(c), cardholder: c.card.user.name })),
    },
  };
}

function isSystemPerson(email: string) {
  return isSystemAddress(email);
}

const issueSchema = z.object({
  templateId: z.string().min(1, "Choose a template"),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("people"), ids: z.array(z.string().min(1)).min(1, "Choose somebody").max(1000) }),
    z.object({ kind: z.literal("department"), id: z.string().min(1) }),
    z.object({ kind: z.literal("branch"), id: z.string().min(1) }),
    z.object({ kind: z.literal("role"), key: z.string().min(1) }),
  ]),
});

export type IssueResult = { issued: number; reissued: number; skipped: { name: string; why: string }[] };

/**
 * Issues cards to people — chosen one by one, or a whole department, branch or role — from a template.
 * Somebody already holding a card is moved to the template (and switched back on). Issuing also lets
 * them use it: where their role doesn't hold "Have a digital card", they get it as a recorded,
 * per-person grant, so a card never sits issued and unreachable.
 */
export async function issueCards(input: unknown): Promise<ActionResult<IssueResult>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.manage"))) return { ok: false, error: "You can't issue digital cards." };
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { templateId, target } = parsed.data;
  const template = await db.cardTemplate.findUnique({ where: { id: templateId }, select: { id: true, name: true } });
  if (!template) return { ok: false, error: "That template no longer exists." };

  const where: Prisma.UserWhereInput =
    target.kind === "people"
      ? { id: { in: target.ids } }
      : target.kind === "department"
        ? { departmentId: target.id, active: true }
        : target.kind === "branch"
          ? { branchId: target.id, active: true }
          : { role: target.key, active: true };
  const people = await db.user.findMany({ where, select: { id: true, name: true, email: true, isSuperAdmin: true } });
  const ids = people.filter((p) => !isSystemPerson(p.email)).map((p) => p.id);
  if (!ids.length) return { ok: false, error: "Nobody there to issue a card to." };

  const result = await issueCardsTo(ids, template.id, user.id);

  // A card nobody can open is no card: give "Have a digital card" to whoever doesn't hold it already.
  const given = [...result.issued, ...result.reissued, ...ids.filter((id) => !result.skipped.some((s) => s.id === id))];
  for (const id of [...new Set(given)]) {
    const person = people.find((p) => p.id === id);
    if (!person || person.isSuperAdmin || (await can(id, "cards.use"))) continue;
    await db.userPermission.upsert({
      where: { user_permission: { userId: id, permission: "cards.use" } },
      update: { allowed: true, reason: "Digital card issued", grantedById: user.id, expiresAt: null },
      create: { userId: id, permission: "cards.use", allowed: true, reason: "Digital card issued", grantedById: user.id },
    });
    await recordPermissionChange({
      actorUserId: user.id,
      subjectType: "USER",
      subjectUserId: id,
      permission: "cards.use",
      fromAllowed: null,
      toAllowed: true,
      changeKind: "GRANT",
      detail: `Have a digital card granted to ${person.name} — digital card issued`,
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "DigitalCard",
    entityId: template.id,
    entityLabel: `${result.issued.length} card(s) issued, ${result.reissued.length} switched back on, from "${template.name}"`,
  });
  revalidatePath("/cards");
  revalidatePath("/cards/manage");
  return { ok: true, data: { issued: result.issued.length, reissued: result.reissued.length, skipped: result.skipped.map(({ name, why }) => ({ name, why })) } };
}

/** Switches one person's card off (it then says they are no longer with the company) or back on. */
export async function setCardActive(userId: string, active: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.manage"))) return { ok: false, error: "You can't switch digital cards on or off." };
  const card = await db.digitalCard.findUnique({ where: { userId }, select: { id: true, templateId: true, user: { select: { name: true } } } });
  if (!card) return { ok: false, error: "They don't have a card." };
  if (active) {
    const result = await issueCardsTo([userId], card.templateId, user.id);
    if (result.skipped.length) return { ok: false, error: `Not switched on: ${result.skipped[0]!.why}.` };
  } else {
    await switchOffCardFor(userId, "manual");
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "DigitalCard", entityId: card.id, entityLabel: `${card.user.name}'s card switched ${active ? "on" : "off"}` });
  revalidatePath("/cards/manage");
  revalidatePath("/cards");
  return { ok: true, data: null };
}

const templateSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(2, "Name the template").max(60, "Keep the name under 60 characters"),
  accentColor: z.string().regex(HEX, "Colours are #rrggbb"),
  coverColor: z.string().regex(HEX, "Colours are #rrggbb"),
  showLogo: z.boolean(),
  fields: z
    .array(
      z.object({
        key: z.string(),
        on: z.boolean(),
        locked: z.boolean(),
        value: z.string().trim().max(MAX_FIELD_LENGTH, "Keep each value under 200 characters").optional(),
      }),
    )
    .max(CARD_FIELDS.length * 2),
  questions: z.array(z.string().trim().max(120, "Keep each question under 120 characters")).max(MAX_QUESTIONS, `Up to ${MAX_QUESTIONS} questions`),
  makeDefault: z.boolean().optional(),
});

/** Creates or changes a template. Every card on it changes with it — the answer says how many. */
export async function saveCardTemplate(input: unknown): Promise<ActionResult<{ id: string; cards: number }>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.manage"))) return { ok: false, error: "You can't change card templates." };
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, name, accentColor, coverColor, showLogo, makeDefault } = parsed.data;
  const fields = readTemplateFields(parsed.data.fields) as unknown as Prisma.InputJsonValue;
  const questions = readQuestions(parsed.data.questions) as unknown as Prisma.InputJsonValue;

  const clash = await db.cardTemplate.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(id ? { NOT: { id } } : {}) }, select: { id: true } });
  if (clash) return { ok: false, error: "Another template already has that name." };

  const saved = await db.$transaction(async (tx) => {
    if (makeDefault) await tx.cardTemplate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const data = { name, accentColor, coverColor, showLogo, fields, questions, ...(makeDefault ? { isDefault: true } : {}) };
    const row = id
      ? await tx.cardTemplate.update({ where: { id }, data, select: { id: true, _count: { select: { cards: true } } } })
      : await tx.cardTemplate.create({ data, select: { id: true, _count: { select: { cards: true } } } });
    await ensureDefaultTemplate(tx);
    return row;
  });
  await recordAudit({ userId: user.id, action: id ? "UPDATE" : "CREATE", entityType: "CardTemplate", entityId: saved.id, entityLabel: name });
  revalidatePath("/cards/manage");
  revalidatePath("/cards");
  return { ok: true, data: { id: saved.id, cards: saved._count.cards } };
}

/** Deletes a template nobody's card uses. The last template can't go: issuing needs one. */
export async function deleteCardTemplate(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("cards");
  if (!(await holds(user.id, "cards.manage"))) return { ok: false, error: "You can't change card templates." };
  const template = await db.cardTemplate.findUnique({ where: { id }, select: { id: true, name: true, _count: { select: { cards: true } } } });
  if (!template) return { ok: false, error: "That template no longer exists." };
  if (template._count.cards > 0) return { ok: false, error: `${template._count.cards} card(s) use it. Move them to another template first.` };
  if ((await db.cardTemplate.count()) <= 1) return { ok: false, error: "Keep at least one template — cards are issued from it." };
  await db.$transaction(async (tx) => {
    await tx.cardTemplate.delete({ where: { id } });
    await ensureDefaultTemplate(tx);
  });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "CardTemplate", entityId: id, entityLabel: template.name });
  revalidatePath("/cards/manage");
  return { ok: true, data: null };
}
