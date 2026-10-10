import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import {
  defaultTemplateFields,
  freeSlug,
  readCardValues,
  readQuestions,
  readTemplateFields,
  resolveCard,
  slugBase,
  type CardPerson,
  type ResolvedCard,
  type TemplateField,
} from "@/lib/cards/template";

/**
 * Deskzo Cards on the server: reading a card with everything it shows, issuing one, and switching one
 * off when somebody leaves. Server-only — never exported from a "use server" file, where every export
 * is an endpoint.
 */

type Tx = Prisma.TransactionClient;

export const DEFAULT_TEMPLATE_NAME = "Company card";

/** The template a card is issued from when nobody chose one, made the first time it is needed. */
export async function ensureDefaultTemplate(tx: Tx = db): Promise<{ id: string }> {
  const existing = await tx.cardTemplate.findFirst({ where: { isDefault: true }, select: { id: true } });
  if (existing) return existing;
  const any = await tx.cardTemplate.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  if (any) {
    await tx.cardTemplate.update({ where: { id: any.id }, data: { isDefault: true } });
    return any;
  }
  try {
    return await tx.cardTemplate.create({
      data: { name: DEFAULT_TEMPLATE_NAME, isDefault: true, fields: defaultTemplateFields() as unknown as Prisma.InputJsonValue },
      select: { id: true },
    });
  } catch (err) {
    // Two first visits at once: the other made it.
    if (!isUniqueViolation(err)) throw err;
    return tx.cardTemplate.findFirstOrThrow({ where: { name: DEFAULT_TEMPLATE_NAME }, select: { id: true } });
  }
}

/** The company a card speaks for: the employer's name and mark, as the letterhead uses them. */
export type CardCompany = { name: string; logoDataUrl: string | null; phone: string | null; email: string | null; address: string | null };

export async function cardCompany(): Promise<CardCompany> {
  const [org, branding] = await Promise.all([
    getOrganisation(),
    db.brandingSettings.findUnique({ where: { id: "global" }, select: { appName: true, logoDataUrl: true } }).catch(() => null),
  ]);
  const name = org.tradeName?.trim() || org.legalName?.trim() || branding?.appName || "";
  const address = [org.addressLine1, org.addressLine2, org.city, org.state, org.pincode].filter((p) => p?.trim()).join(", ");
  return {
    name,
    logoDataUrl: org.letterheadLogoDataUrl ?? branding?.logoDataUrl ?? null,
    phone: org.phone,
    email: org.email,
    address: address || null,
  };
}

const PERSON_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  active: true,
  photoUpdatedAt: true,
  employeeProfile: { select: { designation: true, exitedOn: true } },
  branch: { select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true } },
} satisfies Prisma.UserSelect;

type PersonRow = Prisma.UserGetPayload<{ select: typeof PERSON_SELECT }>;

function personFrom(user: PersonRow): CardPerson {
  const b = user.branch;
  const branchAddress = b ? [b.addressLine1, b.addressLine2, b.city, b.state, b.pincode].filter((p) => p?.trim()).join(", ") : "";
  return {
    name: user.name,
    title: user.employeeProfile?.designation ?? null,
    workPhone: user.phone,
    email: user.email,
    hasPhoto: user.photoUpdatedAt !== null,
    branchAddress: branchAddress || null,
  };
}

/** `yyyy-mm-dd` of a `@db.Date` — the calendar day it names, whatever the server's zone. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today on the workspace's own clock, `yyyy-mm-dd` — what "their last working day has passed" is read against. */
export async function workspaceToday(): Promise<string> {
  try {
    return (await workspaceClock()).today();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Whether somebody's last working day is behind them, on the workspace's calendar. */
export function hasLeft(exitedOn: Date | null | undefined, today: string): boolean {
  return !!exitedOn && dayKey(exitedOn) < today;
}

/**
 * Whether a card speaks for somebody today — the one rule every screen and action uses. Off when
 * switched off, when their account is off, or once their last working day is behind them (it works
 * through that day). Read from the exit date, so a card goes dark with no job having to run
 * (docs/digital-cards-and-signatures.md §3.7).
 */
export function cardOffReason(
  card: { active: boolean; switchedOffWhy: string | null },
  user: { active: boolean; employeeProfile: { exitedOn: Date | null } | null },
  today: string,
): "exit" | "account" | "manual" | null {
  // A recorded exit is the reason whenever there is one — it is the only one the public page names.
  if (hasLeft(user.employeeProfile?.exitedOn, today) || (!card.active && card.switchedOffWhy === "exit")) return "exit";
  if (!user.active) return "account";
  if (!card.active) return card.switchedOffWhy === "account" ? "account" : "manual";
  return null;
}

export type LoadedCard = {
  id: string;
  slug: string;
  active: boolean;
  /** Null when the card is live; otherwise why it isn't. */
  offReason: "exit" | "account" | "manual" | null;
  userId: string;
  photoVersion: number | null;
  template: { id: string; name: string; accentColor: string; coverColor: string; showLogo: boolean; fields: TemplateField[]; questions: string[] };
  values: ReturnType<typeof readCardValues>;
  resolved: ResolvedCard;
};

const CARD_INCLUDE = { user: { select: PERSON_SELECT }, template: true } satisfies Prisma.DigitalCardInclude;
type CardRow = Prisma.DigitalCardGetPayload<{ include: typeof CARD_INCLUDE }>;

function loaded(card: CardRow, today: string): LoadedCard {
  const fields = readTemplateFields(card.template.fields);
  const values = readCardValues(card.values);
  return {
    id: card.id,
    slug: card.slug,
    active: card.active,
    offReason: cardOffReason(card, card.user, today),
    userId: card.userId,
    photoVersion: card.user.photoUpdatedAt?.getTime() ?? null,
    template: {
      id: card.template.id,
      name: card.template.name,
      accentColor: card.template.accentColor,
      coverColor: card.template.coverColor,
      showLogo: card.template.showLogo,
      fields,
      questions: readQuestions(card.template.questions),
    },
    values,
    resolved: resolveCard(fields, values, personFrom(card.user)),
  };
}

export async function loadCardBySlug(slug: string): Promise<LoadedCard | null> {
  const [card, today] = await Promise.all([db.digitalCard.findUnique({ where: { slug }, include: CARD_INCLUDE }), workspaceToday()]);
  return card ? loaded(card, today) : null;
}

export async function loadCardForUser(userId: string): Promise<LoadedCard | null> {
  const [card, today] = await Promise.all([db.digitalCard.findUnique({ where: { userId }, include: CARD_INCLUDE }), workspaceToday()]);
  return card ? loaded(card, today) : null;
}

/**
 * Issues cards — or switches back on the ones already issued — for these people, from one template.
 * Somebody switched off as an account, or whose exit is recorded, is skipped: a card speaks for the
 * company, and they no longer do. Addresses are given once and kept for life.
 */
export async function issueCardsTo(
  userIds: readonly string[],
  templateId: string,
  byUserId: string,
): Promise<{ issued: string[]; reissued: string[]; skipped: { id: string; name: string; why: string }[] }> {
  // Two admins issuing at once can pick the same address, or both reach the same person: the database's
  // unique indexes refuse the second, and the run starts again from what is there now.
  for (let attempt = 0; ; attempt++) {
    try {
      return await issueOnce(userIds, templateId, byUserId);
    } catch (err) {
      if (attempt < 3 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: unknown }).code === "P2002";
}

async function issueOnce(
  userIds: readonly string[],
  templateId: string,
  byUserId: string,
): Promise<{ issued: string[]; reissued: string[]; skipped: { id: string; name: string; why: string }[] }> {
  const people = await db.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, name: true, active: true, employeeProfile: { select: { exitedOn: true } }, digitalCard: { select: { id: true, active: true } } },
  });
  const issued: string[] = [];
  const reissued: string[] = [];
  const skipped: { id: string; name: string; why: string }[] = [];
  const today = await workspaceToday();
  for (const p of people) {
    if (!p.active) skipped.push({ id: p.id, name: p.name, why: "their account is switched off" });
    else if (hasLeft(p.employeeProfile?.exitedOn, today)) skipped.push({ id: p.id, name: p.name, why: "they have left" });
  }
  const eligible = people.filter((p) => !skipped.some((s) => s.id === p.id));

  await db.$transaction(async (tx) => {
    const fresh = eligible.filter((p) => !p.digitalCard);
    const taken = new Set<string>();
    if (fresh.length) {
      const bases = [...new Set(fresh.map((p) => slugBase(p.name)))];
      const existing = await tx.digitalCard.findMany({
        where: { OR: bases.map((b) => ({ slug: { startsWith: b } })) },
        select: { slug: true },
      });
      for (const e of existing) taken.add(e.slug);
    }
    for (const p of eligible) {
      if (p.digitalCard) {
        await tx.digitalCard.update({
          where: { id: p.digitalCard.id },
          data: { templateId, active: true, switchedOffAt: null, switchedOffWhy: null },
        });
        if (!p.digitalCard.active) reissued.push(p.id);
        continue;
      }
      const slug = freeSlug(p.name, taken);
      taken.add(slug);
      await tx.digitalCard.create({ data: { userId: p.id, templateId, slug, issuedById: byUserId } });
      issued.push(p.id);
    }
  });
  return { issued, reissued, skipped };
}

/**
 * Switches somebody's card off — on their exit, when their account is switched off, or by hand. The
 * address keeps working and says they are no longer with the company; the leads it collected stay
 * with the company and move in the exit hand-over like any other lead.
 *
 * Never throws: it runs inside other people's flows (recording an exit, switching an account off),
 * and a workspace whose database predates cards simply has none to switch off.
 */
export async function switchOffCardFor(userId: string, why: "exit" | "account" | "manual"): Promise<boolean> {
  try {
    const result = await db.digitalCard.updateMany({
      where: { userId, active: true },
      data: { active: false, switchedOffAt: new Date(), switchedOffWhy: why },
    });
    return result.count > 0;
  } catch {
    return false;
  }
}

/** A day's start, `days` ago — the "this week" the numbers are counted over. */
export function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

export type CardStats = { views: number; saves: number; taps: number; shared: number };

const EMPTY_STATS: CardStats = { views: 0, saves: 0, taps: 0, shared: 0 };

/** Views, saves, link taps and share-backs per card, since `since` (or ever). */
export async function cardStats(cardIds: readonly string[], since?: Date): Promise<Map<string, CardStats>> {
  const out = new Map<string, CardStats>(cardIds.map((id) => [id, { ...EMPTY_STATS }]));
  if (!cardIds.length) return out;
  const rows = await db.cardEvent.groupBy({
    by: ["cardId", "kind"],
    where: { cardId: { in: [...cardIds] }, ...(since ? { createdAt: { gte: since } } : {}) },
    _count: { _all: true },
  });
  for (const r of rows) {
    const s = out.get(r.cardId);
    if (!s) continue;
    const n = r._count._all;
    if (r.kind === "VIEW") s.views = n;
    else if (r.kind === "SAVE") s.saves = n;
    else if (r.kind === "TAP") s.taps = n;
    else s.shared = n;
  }
  return out;
}
