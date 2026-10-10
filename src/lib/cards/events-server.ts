import { randomBytes } from "node:crypto";
import type { CardContactVia } from "@prisma/client";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { currentTenant } from "@/lib/tenancy/resolve";
import { classifyHost, normaliseHost, protocolFor } from "@/lib/tenancy/host";
import { readQuestions, type CardQuestion } from "@/lib/cards/fields";
import { dayOf, eventDays, eventState, parseVCard, type EventState, type ScannedContact } from "@/lib/cards/events";
import { publicCard } from "@/lib/cards/server";

/**
 * Deskzo Cards' events on the server: which event somebody is working today, the booth form, an
 * event's results, and a scanned card read into a contact.
 */

/** The booth link's key: ten letters and digits, nothing about the event in it. */
export function newEventCode(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(10)].map((b) => alphabet[b % alphabet.length]).join("");
}

export type EventSummary = {
  id: string;
  name: string;
  venue: string | null;
  startsOn: string;
  endsOn: string;
  goal: number | null;
  cost: number | null;
  code: string;
  questions: CardQuestion[];
  state: EventState;
  memberIds: string[];
};

type EventRow = {
  id: string;
  name: string;
  venue: string | null;
  startsOn: Date;
  endsOn: Date;
  goal: number | null;
  cost: { toString(): string } | null;
  code: string;
  questions: unknown;
  members: { userId: string }[];
};

const EVENT_SELECT = {
  id: true,
  name: true,
  venue: true,
  startsOn: true,
  endsOn: true,
  goal: true,
  cost: true,
  code: true,
  questions: true,
  members: { select: { userId: true } },
} as const;

function summarise(row: EventRow, today: string): EventSummary {
  const days = { startsOn: dayOf(row.startsOn), endsOn: dayOf(row.endsOn) };
  return {
    id: row.id,
    name: row.name,
    venue: row.venue,
    ...days,
    goal: row.goal,
    // A Decimal never crosses to the browser (src/lib/serialize.ts's lesson): a number does.
    cost: row.cost === null ? null : Number(row.cost.toString()),
    code: row.code,
    questions: readQuestions(row.questions),
    state: eventState(days, today),
    memberIds: row.members.map((m) => m.userId),
  };
}

export async function loadEvent(id: string): Promise<EventSummary | null> {
  const today = (await workspaceClock()).today();
  const row = (await db.cardCampaign.findUnique({ where: { id }, select: EVENT_SELECT })) as EventRow | null;
  return row ? summarise(row, today) : null;
}

/** Every event, newest first — for whoever manages cards. */
export async function allEvents(): Promise<EventSummary[]> {
  const today = (await workspaceClock()).today();
  const rows = (await db.cardCampaign.findMany({ orderBy: [{ startsOn: "desc" }, { name: "asc" }], select: EVENT_SELECT })) as EventRow[];
  return rows.map((r) => summarise(r, today));
}

/** The events somebody works that haven't ended more than a week ago, soonest first. */
export async function eventsFor(userId: string): Promise<EventSummary[]> {
  const clock = await workspaceClock();
  const today = clock.today();
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000);
  const rows = (await db.cardCampaign.findMany({
    where: { members: { some: { userId } }, endsOn: { gte: weekAgo } },
    orderBy: { startsOn: "asc" },
    select: EVENT_SELECT,
  })) as EventRow[];
  return rows.map((r) => summarise(r, today));
}

/**
 * The one event a card's holder is working today, if exactly one — a share-back from their card on its
 * days counts towards it. Two at once, and neither gets it: a guess would be wrong half the time.
 */
export async function liveEventOf(userId: string, today: string): Promise<{ id: string; name: string } | null> {
  const day = new Date(`${today}T00:00:00Z`);
  const rows = await db.cardCampaign.findMany({
    where: { members: { some: { userId } }, startsOn: { lte: day }, endsOn: { gte: day } },
    select: { id: true, name: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0]! : null;
}

/** The event a booth link names, when it is running today and the card's holder works it. */
export async function boothEvent(code: string | null | undefined, userId: string, today: string) {
  if (!code || !/^[a-z0-9]{6,20}$/.test(code)) return null;
  const row = await db.cardCampaign.findUnique({
    where: { code },
    select: { id: true, name: true, startsOn: true, endsOn: true, questions: true, members: { where: { userId }, select: { userId: true } } },
  });
  if (!row || row.members.length === 0) return null;
  if (eventState({ startsOn: dayOf(row.startsOn), endsOn: dayOf(row.endsOn) }, today) !== "live") return null;
  return { id: row.id, name: row.name, questions: readQuestions(row.questions) };
}

/** Everybody who could work an event, and whether they have a card switched on (a booth form needs one). */
export async function teamChoices(): Promise<{ id: string; name: string; department: string | null; hasCard: boolean }[]> {
  const people = await db.user.findMany({
    where: { active: true, kind: "MEMBER" },
    orderBy: { name: "asc" },
    select: { id: true, name: true, department: { select: { name: true } }, digitalCard: { select: { status: true } } },
  });
  return people.map((p) => ({ id: p.id, name: p.name, department: p.department?.name ?? null, hasCard: p.digitalCard?.status === "ACTIVE" }));
}

// ── Results ─────────────────────────────────────────────────────────────────────────────────────────

export type EventResults = {
  met: number;
  leads: number;
  byVia: Record<CardContactVia, number>;
  byPerson: { userId: string; name: string; met: number; leads: number }[];
  byDay: { day: string; met: number }[];
  costPerPerson: number | null;
};

/** Who the team met, by how, by whom and by day; and what each cost when the event's cost is known. */
export async function eventResults(event: EventSummary): Promise<EventResults> {
  const clock = await workspaceClock();
  const [contacts, members] = await Promise.all([
    db.cardContact.findMany({ where: { campaignId: event.id }, select: { via: true, ownerUserId: true, leadId: true, createdAt: true, card: { select: { userId: true } } } }),
    db.user.findMany({ where: { id: { in: event.memberIds } }, select: { id: true, name: true } }),
  ]);
  const byVia: Record<CardContactVia, number> = { SHARE_BACK: 0, BOOTH: 0, SCAN: 0 };
  // Credited to whoever met them — the card's holder, or whoever scanned — not whoever holds them now.
  const person = new Map(members.map((m) => [m.id, { userId: m.id, name: m.name, met: 0, leads: 0 }]));
  const days = new Map(eventDays(event).map((d) => [d, 0]));
  const names = new Map(members.map((m) => [m.id, m.name]));
  const outsiders = contacts.map((c) => c.card?.userId ?? c.ownerUserId).filter((id) => !names.has(id));
  if (outsiders.length) {
    for (const u of await db.user.findMany({ where: { id: { in: [...new Set(outsiders)] } }, select: { id: true, name: true } })) {
      person.set(u.id, { userId: u.id, name: u.name, met: 0, leads: 0 });
    }
  }
  for (const c of contacts) {
    byVia[c.via]++;
    const who = person.get(c.card?.userId ?? c.ownerUserId);
    if (who) {
      who.met++;
      if (c.leadId) who.leads++;
    }
    const day = clock.dateKey(c.createdAt);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const met = contacts.length;
  return {
    met,
    leads: contacts.filter((c) => c.leadId).length,
    byVia,
    byPerson: [...person.values()].sort((a, b) => b.met - a.met || a.name.localeCompare(b.name)),
    byDay: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, met: n })),
    costPerPerson: event.cost !== null && met > 0 ? Math.round((event.cost / met) * 100) / 100 : null,
  };
}

// ── A scanned card ──────────────────────────────────────────────────────────────────────────────────

/**
 * A Deskzo card's address, read into a contact. This workspace's own cards are read from the
 * database; another workspace's — only ever an address on the platform's own domain, a workspace's
 * /c/<name> — by asking that card for its contact file, as a phone would. Nothing else is fetched: the
 * address came from a QR somebody held up, so it is never trusted to point anywhere else.
 */
export async function contactFromCardAddress(hostRaw: string, handle: string): Promise<ScannedContact | null> {
  const host = normaliseHost(hostRaw);
  if (!host || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle)) return null;
  const kind = classifyHost(host);
  if (kind.kind !== "tenant") return null;

  if (kind.slug === (await currentTenant()).slug) {
    const card = await publicCard(handle);
    if (!card || card.state !== "live") return null;
    const field = (k: string) => card.card.fields.find((f) => f.kind === k)?.value ?? "";
    return {
      name: card.card.name,
      email: field("email"),
      phone: field("phone") || field("whatsapp"),
      company: card.card.company ?? "",
      jobTitle: card.card.title ?? "",
      link: `${protocolFor(host)}://${host}/c/${handle}`,
    };
  }

  try {
    const response = await fetch(`${protocolFor(host)}://${host}/c/${handle}/vcard`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const text = (await response.text()).slice(0, 200_000);
    const contact = parseVCard(text);
    return contact ? { ...contact, link: contact.link || `${protocolFor(host)}://${host}/c/${handle}` } : null;
  } catch {
    return null;
  }
}
