import { Prisma, type CardEventKind, type CardTemplate } from "@prisma/client";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { workspaceClock } from "@/lib/time/workspace";
import {
  DEFAULT_RECORD_FIELDS,
  MAX_OWN_FIELDS,
  MAX_SHARED_FIELDS,
  drawCard,
  handleFrom,
  readFields,
  readQuestions,
  readRecordFields,
  type CardField,
  type CardQuestion,
  type CardRecord,
  type DrawnCard,
  type RecordFieldSetting,
} from "@/lib/cards/fields";

/**
 * Deskzo Cards on the server: templates, issuing, a card's record, the public card and its numbers.
 * The rules for fields themselves are in fields.ts, which the browser shares.
 */

export type TemplateSpec = {
  id: string;
  name: string;
  isDefault: boolean;
  color: string;
  layout: "CLASSIC" | "CENTRED";
  showLogo: boolean;
  recordFields: RecordFieldSetting[];
  sharedFields: CardField[];
  allowOwnFields: boolean;
  shareBack: boolean;
  questions: CardQuestion[];
};

const HEX = /^#[0-9a-f]{6}$/i;

export function readTemplate(row: CardTemplate): TemplateSpec {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    color: HEX.test(row.color) ? row.color.toLowerCase() : "#1d4ed8",
    layout: row.layout === "CENTRED" ? "CENTRED" : "CLASSIC",
    showLogo: row.showLogo,
    recordFields: readRecordFields(row.recordFields),
    sharedFields: readFields(row.sharedFields, MAX_SHARED_FIELDS),
    allowOwnFields: row.allowOwnFields,
    shareBack: row.shareBack,
    questions: readQuestions(row.questions),
  };
}

/**
 * The default template, made the first time anybody needs one: the workspace's brand colour, its
 * logo, every record field but the department. Two requests making it at once both end with the same
 * one — the database allows exactly one default.
 */
export async function defaultTemplate(actorId: string | null): Promise<CardTemplate> {
  const existing = await db.cardTemplate.findFirst({ where: { isDefault: true } });
  if (existing) return existing;
  const branding = await getBranding();
  try {
    return await db.cardTemplate.create({
      data: {
        name: "Company card",
        isDefault: true,
        color: branding.primaryColor && HEX.test(branding.primaryColor) ? branding.primaryColor.toLowerCase() : "#1d4ed8",
        recordFields: DEFAULT_RECORD_FIELDS as unknown as Prisma.InputJsonValue,
        createdById: actorId,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return db.cardTemplate.findFirstOrThrow({ where: { isDefault: true } });
    }
    throw err;
  }
}

/** A card address nobody has: the name's, then -2, -3… and, past that, a few random letters. */
export async function uniqueHandle(name: string, client: Prisma.TransactionClient | typeof db = db): Promise<string> {
  const base = handleFrom(name);
  const taken = new Set(
    (await client.digitalCard.findMany({ where: { handle: { startsWith: base } }, select: { handle: true } })).map((c) => c.handle),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const next = `${base}-${n}`;
    if (!taken.has(next)) return next;
  }
  return `${base}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Whether a card is live, from what was loaded — the same rule as `liveCardWhere` (holder.ts). */
export function isLive(
  card: { status: string; user: { active: boolean; kind: string; employeeProfile: { exitedOn: Date | null } | null } },
  today: string,
): boolean {
  if (card.status !== "ACTIVE" || !card.user.active || card.user.kind !== "MEMBER") return false;
  const exited = card.user.employeeProfile?.exitedOn;
  return !exited || exited.toISOString().slice(0, 10) >= today;
}

const HOLDER_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  active: true,
  kind: true,
  photoUpdatedAt: true,
  department: { select: { name: true } },
  branch: { select: { addressLine1: true, addressLine2: true, city: true, state: true, pincode: true } },
  employeeProfile: { select: { designation: true, exitedOn: true } },
} as const;

/**
 * Written out rather than `Prisma.UserGetPayload<…>` over the select: that, nested in the card's select below,
 * ran tsc out of heap with no error to show for it.
 */
export type Holder = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  kind: string;
  photoUpdatedAt: Date | null;
  department: { name: string } | null;
  branch: { addressLine1: string | null; addressLine2: string | null; city: string | null; state: string | null; pincode: string | null } | null;
  employeeProfile: { designation: string | null; exitedOn: Date | null } | null;
};

function joinAddress(parts: (string | null | undefined)[]): string | null {
  const text = parts.map((p) => p?.trim()).filter(Boolean).join(", ");
  return text || null;
}

/** The company's name, as a card prints it: the trading name, else the legal one. */
export async function companyName(): Promise<string | null> {
  const org = await getOrganisation();
  return org.tradeName?.trim() || org.legalName?.trim() || null;
}

/** What the holder's record puts on a card. The address is their branch's, else the company's. */
async function recordOf(holder: Holder): Promise<CardRecord> {
  const org = await getOrganisation();
  const branch = holder.branch;
  const address = branch
    ? joinAddress([branch.addressLine1, branch.addressLine2, branch.city, branch.state, branch.pincode])
    : joinAddress([org.addressLine1, org.addressLine2, org.city, org.state, org.pincode]);
  return {
    name: holder.name,
    title: holder.employeeProfile?.designation?.trim() || null,
    department: holder.department?.name ?? null,
    company: org.tradeName?.trim() || org.legalName?.trim() || null,
    phone: holder.phone?.trim() || null,
    email: holder.email,
    address,
    hasPhoto: !!holder.photoUpdatedAt,
  };
}

/** A card as it draws, for its holder, a manager, or the public page. */
export async function drawnCardFor(card: {
  user: Holder;
  hidden: string[];
  ownFields: Prisma.JsonValue;
  template: TemplateSpec;
}): Promise<DrawnCard> {
  return drawCard({
    record: await recordOf(card.user),
    recordFields: card.template.recordFields,
    hidden: card.hidden,
    shared: card.template.sharedFields,
    own: readFields(card.ownFields, MAX_OWN_FIELDS),
    allowOwnFields: card.template.allowOwnFields,
  });
}

export type LoadedCard = {
  id: string;
  userId: string;
  templateId: string;
  handle: string;
  status: "ACTIVE" | "OFF";
  ownFields: Prisma.JsonValue;
  hidden: string[];
  template: CardTemplate;
  user: Holder;
  spec: TemplateSpec;
};

export async function loadCard(where: Prisma.DigitalCardWhereUniqueInput): Promise<LoadedCard | null> {
  const card = (await db.digitalCard.findUnique({
    where,
    select: { id: true, userId: true, templateId: true, handle: true, status: true, ownFields: true, hidden: true, template: true, user: { select: HOLDER_SELECT } },
  })) as unknown as Omit<LoadedCard, "spec"> | null;
  if (!card) return null;
  return { ...card, spec: readTemplate(card.template) };
}

export type PublicCard =
  | {
      state: "live";
      cardId: string;
      handle: string;
      card: DrawnCard;
      color: string;
      layout: "CLASSIC" | "CENTRED";
      showLogo: boolean;
      shareBack: boolean;
      questions: CardQuestion[];
      firstName: string;
      /** Changes when the photo does, so the browser's copy is never stale. */
      photoVersion: number | null;
    }
  | {
      state: "gone";
      company: string | null;
      phone: string | null;
      email: string | null;
      showLogo: boolean;
      color: string;
    };

/**
 * The public card at /c/<handle>, or null when there is no such card. A card that isn't live — switched
 * off, or its holder gone — still answers, with the company's own details instead of the person's: a
 * card in somebody's contacts or an NFC tag on a desk keeps pointing at the company.
 */
export async function publicCard(handle: string): Promise<PublicCard | null> {
  const card = await loadCard({ handle });
  if (!card) return null;
  const today = (await workspaceClock()).today();
  if (!isLive(card, today)) {
    const org = await getOrganisation();
    return {
      state: "gone",
      company: org.tradeName?.trim() || org.legalName?.trim() || null,
      phone: org.phone?.trim() || null,
      email: org.email?.trim() || null,
      showLogo: card.spec.showLogo,
      color: card.spec.color,
    };
  }
  const drawn = await drawnCardFor({ user: card.user, hidden: card.hidden, ownFields: card.ownFields, template: card.spec });
  return {
    state: "live",
    cardId: card.id,
    handle: card.handle,
    card: drawn,
    color: card.spec.color,
    layout: card.spec.layout,
    showLogo: card.spec.showLogo,
    shareBack: card.spec.shareBack,
    questions: card.spec.questions,
    firstName: card.user.name.trim().split(/\s+/)[0] ?? card.user.name,
    photoVersion: drawn.showPhoto && card.user.photoUpdatedAt ? card.user.photoUpdatedAt.getTime() : null,
  };
}

// ── Numbers ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * How many events one card may record a minute, of each kind. A page reload is a view; a script
 * reloading it all day is not, and the table is not a place to store that.
 */
const EVENTS_PER_MINUTE = 30;

export async function recordCardEvent(cardId: string, kind: CardEventKind, detail?: string | null): Promise<void> {
  const recent = await db.cardEvent.count({ where: { cardId, kind, at: { gte: new Date(Date.now() - 60_000) } } });
  if (recent >= EVENTS_PER_MINUTE) return;
  await db.cardEvent.create({ data: { cardId, kind, detail: detail ? detail.slice(0, 40) : null } });
}

export type CardNumbers = { views: number; saves: number; taps: number; shared: number };

const ZERO: CardNumbers = { views: 0, saves: 0, taps: 0, shared: 0 };

/** Each card's numbers since a moment (or ever). */
export async function cardNumbers(cardIds: string[], since?: Date): Promise<Map<string, CardNumbers>> {
  const out = new Map<string, CardNumbers>(cardIds.map((id) => [id, { ...ZERO }]));
  if (cardIds.length === 0) return out;
  const rows = await db.cardEvent.groupBy({
    by: ["cardId", "kind"],
    where: { cardId: { in: cardIds }, ...(since ? { at: { gte: since } } : {}) },
    _count: { _all: true },
  });
  for (const row of rows) {
    const n = out.get(row.cardId);
    if (!n) continue;
    const count = row._count._all;
    if (row.kind === "VIEW") n.views += count;
    else if (row.kind === "SAVE") n.saves += count;
    else if (row.kind === "TAP") n.taps += count;
    else if (row.kind === "SHARE_BACK") n.shared += count;
  }
  return out;
}

// ── Issuing ─────────────────────────────────────────────────────────────────────────────────────────

/** New cards, cards switched back on, cards moved to the template named, and people left as they were. */
export type IssueOutcome = { issued: number; switchedOn: number; moved: number; skipped: number };

/**
 * Cards for these people, from a template (the default when none is named). Somebody who already has
 * one has it switched back on, keeping its address and their own fields; only a template named here
 * replaces theirs. Switched-off accounts and anybody who isn't a member are skipped.
 */
export async function issueCards(input: { userIds: string[]; templateId: string | null; actorId: string }): Promise<IssueOutcome> {
  const template = input.templateId
    ? await db.cardTemplate.findUnique({ where: { id: input.templateId } })
    : await defaultTemplate(input.actorId);
  if (!template) throw new Error("That template no longer exists.");

  const people = await db.user.findMany({
    where: { id: { in: [...new Set(input.userIds)] }, active: true, kind: "MEMBER" },
    select: { id: true, name: true, digitalCard: { select: { id: true, status: true, templateId: true } } },
  });
  const outcome: IssueOutcome = { issued: 0, switchedOn: 0, moved: 0, skipped: new Set(input.userIds).size - people.length };

  for (const person of people) {
    const existing = person.digitalCard;
    if (existing) {
      const off = existing.status !== "ACTIVE";
      const move = !!input.templateId && existing.templateId !== template.id;
      if (!off && !move) {
        outcome.skipped++;
        continue;
      }
      await db.digitalCard.update({
        where: { id: existing.id },
        data: {
          ...(off ? { status: "ACTIVE" as const, switchedOffAt: null, switchedOffById: null } : {}),
          ...(move ? { templateId: template.id } : {}),
        },
      });
      if (off) outcome.switchedOn++;
      else outcome.moved++;
      continue;
    }
    // A handle taken between choosing it and writing it: choose again, a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        await db.digitalCard.create({
          data: { userId: person.id, templateId: template.id, handle: await uniqueHandle(person.name), issuedById: input.actorId },
        });
        outcome.issued++;
        break;
      } catch (err) {
        const retry = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && attempt < 4;
        if (!retry) throw err;
      }
    }
  }
  return outcome;
}
