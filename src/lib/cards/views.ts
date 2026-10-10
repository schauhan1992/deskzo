import QRCode from "qrcode";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { leadPath } from "@/lib/record-links";
import { MAX_OWN_FIELDS, readFields, type CardField, type DrawnCard } from "@/lib/cards/fields";
import { cardNumbers, drawnCardFor, isLive, loadCard, readTemplate, type CardNumbers, type TemplateSpec } from "@/lib/cards/server";

/**
 * What the signed-in pages of Deskzo Cards show. Plain functions, not actions: the pages check who
 * may see what before calling them, and nothing here is reachable from the browser.
 */

const DAY = 24 * 60 * 60 * 1000;

/** The card's QR code: its address, with the error correction high enough for a logo over the middle. */
export async function cardQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "H", margin: 2, width: 480 });
}

export type MyCardView = {
  id: string;
  handle: string;
  url: string;
  qr: string;
  status: "ACTIVE" | "OFF";
  live: boolean;
  card: DrawnCard;
  template: TemplateSpec;
  hidden: string[];
  ownFields: CardField[];
  photoVersion: number | null;
  week: CardNumbers;
  ever: CardNumbers;
};

export async function myCardView(userId: string): Promise<MyCardView | null> {
  const card = await loadCard({ userId });
  if (!card) return null;
  const today = (await workspaceClock()).today();
  const [drawn, origin, week, ever] = await Promise.all([
    drawnCardFor({ user: card.user, hidden: card.hidden, ownFields: card.ownFields, template: card.spec }),
    tenantOrigin(),
    cardNumbers([card.id], new Date(Date.now() - 7 * DAY)),
    cardNumbers([card.id]),
  ]);
  const url = `${origin}/c/${card.handle}`;
  return {
    id: card.id,
    handle: card.handle,
    url,
    qr: await cardQr(url),
    status: card.status,
    live: isLive(card, today),
    card: drawn,
    template: card.spec,
    hidden: card.hidden,
    ownFields: readFields(card.ownFields, MAX_OWN_FIELDS),
    photoVersion: card.user.photoUpdatedAt ? card.user.photoUpdatedAt.getTime() : null,
    week: week.get(card.id)!,
    ever: ever.get(card.id)!,
  };
}

export type CardContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  message: string | null;
  answers: { label: string; answer: string }[];
  note: string | null;
  createdAt: string;
  /** Whoever met them: the card's holder, or whoever scanned them. */
  holder: string;
  owner: string;
  leadLink: string | null;
  via: "SHARE_BACK" | "BOOTH" | "SCAN";
  event: string | null;
};

/**
 * The people met through cards: one person's (whoever holds them now), everybody's for a card manager,
 * or one event's — all of it, or one person's part of it.
 */
export async function cardContacts(
  scope: { ownerUserId: string } | "all" | { campaignId: string; ownerUserId?: string },
  take = 200,
): Promise<CardContactRow[]> {
  const where =
    scope === "all"
      ? {}
      : "campaignId" in scope
        ? { campaignId: scope.campaignId, ...(scope.ownerUserId ? { ownerUserId: scope.ownerUserId } : {}) }
        : { ownerUserId: scope.ownerUserId };
  const rows = await db.cardContact.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      company: true,
      jobTitle: true,
      message: true,
      answers: true,
      note: true,
      createdAt: true,
      owner: { select: { name: true } },
      card: { select: { user: { select: { name: true } } } },
      lead: { select: { leadSeq: true } },
      via: true,
      campaign: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    jobTitle: r.jobTitle,
    message: r.message,
    answers: Array.isArray(r.answers)
      ? (r.answers as unknown[]).flatMap((a) => {
          const x = a as { label?: unknown; answer?: unknown };
          return typeof x?.label === "string" && typeof x?.answer === "string" ? [{ label: x.label, answer: x.answer }] : [];
        })
      : [],
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    holder: r.card?.user.name ?? r.owner.name,
    owner: r.owner.name,
    leadLink: r.lead ? leadPath(r.lead.leadSeq) : null,
    via: r.via,
    event: r.campaign?.name ?? null,
  }));
}

export type ManagedPerson = {
  userId: string;
  name: string;
  email: string;
  department: string | null;
  departmentId: string | null;
  branch: string | null;
  branchId: string | null;
  role: string;
  card: null | {
    id: string;
    handle: string;
    status: "ACTIVE" | "OFF";
    live: boolean;
    templateId: string;
    templateName: string;
    month: CardNumbers;
  };
};

/** Everybody active, with their card if they have one — and anybody who has left but still holds one. */
export async function managedPeople(): Promise<ManagedPerson[]> {
  const today = (await workspaceClock()).today();
  const people = await db.user.findMany({
    where: { kind: "MEMBER", OR: [{ active: true }, { digitalCard: { isNot: null } }] },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      kind: true,
      departmentId: true,
      department: { select: { name: true } },
      branchId: true,
      branch: { select: { name: true } },
      employeeProfile: { select: { exitedOn: true } },
      digitalCard: { select: { id: true, handle: true, status: true, templateId: true, template: { select: { name: true } } } },
    },
  });
  const ids = people.flatMap((p) => (p.digitalCard ? [p.digitalCard.id] : []));
  const month = await cardNumbers(ids, new Date(Date.now() - 30 * DAY));
  return people.map((p) => ({
    userId: p.id,
    name: p.name,
    email: p.email,
    department: p.department?.name ?? null,
    departmentId: p.departmentId,
    branch: p.branch?.name ?? null,
    branchId: p.branchId,
    role: p.role,
    card: p.digitalCard
      ? {
          id: p.digitalCard.id,
          handle: p.digitalCard.handle,
          status: p.digitalCard.status,
          live: isLive({ status: p.digitalCard.status, user: p }, today),
          templateId: p.digitalCard.templateId,
          templateName: p.digitalCard.template.name,
          month: month.get(p.digitalCard.id)!,
        }
      : null,
  }));
}

export type TemplateRow = TemplateSpec & { cards: number };

export async function templateRows(): Promise<TemplateRow[]> {
  const rows = await db.cardTemplate.findMany({ orderBy: [{ isDefault: "desc" }, { name: "asc" }], include: { _count: { select: { cards: true } } } });
  return rows.map((r) => ({ ...readTemplate(r), cards: r._count.cards }));
}
