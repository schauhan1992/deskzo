import type { CallOutcome, LeadStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { phoneKey } from "@/lib/companies/duplicates";
import { STILL_THERE } from "@/lib/contacts/left";
import { callAccess, contactAccess, leadAccess, throughAccount } from "@/lib/authz/access";
import { companyRef, contactRef, iso, leadRef } from "@/lib/api/refs";
import { leadsSeenBy } from "@/lib/leads/shown";
import { moduleAccessFor } from "@/lib/modules-access";

/**
 * Which customer a phone number is (owner, 18 Oct 2026) — for the Deskzo app's caller ID and its call sync.
 *
 * A number is its last ten digits, how India writes a mobile with or without +91 or 0 (the duplicate
 * finder's `phoneKey`), looked up through an index on that same expression (migration
 * 20261118130000_deskzo_app_calls). Only the contacts this person could open on a screen count: their
 * account's and the contact's own reach, still at the company, and never a reseller's customer — whom
 * nobody here calls directly (src/lib/reseller.ts). A number on nobody they can see is no match, and a
 * call to it never leaves the phone.
 */

export { phoneKey as numberKey };

export type PhoneMatch = {
  key: string;
  contact: { id: string; ref: string | null; name: string; designation: string };
  company: { id: string; ref: string | null; name: string; ownerUserId: string | null };
  /** How many other contacts this person can see carry the same number. */
  alsoOn: number;
};

/** Contacts whose number ends in each key — the index's own expression, word for word. */
async function contactIdsByKey(keys: string[]): Promise<{ id: string; key: string }[]> {
  if (keys.length === 0) return [];
  return db.$queryRaw<{ id: string; key: string }[]>`
    SELECT "id", right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) AS "key"
    FROM "contacts"
    WHERE "phone" IS NOT NULL AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ANY(${keys}::text[])`;
}

/** Each number's best match this person may see, by its key. Their own accounts first, then a primary contact. */
export async function matchNumbers(userId: string, numbers: string[]): Promise<Map<string, PhoneMatch>> {
  const keys = [...new Set(numbers.map((n) => phoneKey(n)).filter((k): k is string => !!k))];
  const hits = await contactIdsByKey(keys);
  const found = new Map<string, PhoneMatch>();
  if (hits.length === 0) return found;
  const keyOf = new Map(hits.map((h) => [h.id, h.key]));

  const contacts = await db.contact.findMany({
    where: {
      AND: [{ id: { in: hits.map((h) => h.id) } }, STILL_THERE, { company: { managedByResellerId: null } }, await throughAccount(userId, "view"), await contactAccess(userId, "view")],
    },
    select: { id: true, contactSeq: true, name: true, designation: true, isPrimary: true, company: { select: { id: true, companySeq: true, name: true, ownerUserId: true } } },
  });

  const byKey = new Map<string, typeof contacts>();
  for (const c of contacts) {
    const key = keyOf.get(c.id)!;
    byKey.set(key, [...(byKey.get(key) ?? []), c]);
  }
  for (const [key, group] of byKey) {
    const rank = (c: (typeof group)[number]) => (c.company.ownerUserId === userId ? 0 : 2) + (c.isPrimary ? 0 : 1);
    const [best] = [...group].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
    found.set(key, {
      key,
      contact: { id: best!.id, ref: contactRef(best!.contactSeq), name: best!.name, designation: best!.designation },
      company: { id: best!.company.id, ref: companyRef(best!.company.companySeq), name: best!.company.name, ownerUserId: best!.company.ownerUserId },
      alsoOn: group.length - 1,
    });
  }
  return found;
}

/** As many numbers as an iPhone is given ahead of time — a Call Directory loads them all at once. */
export const DIRECTORY_MAX = 20_000;
const DIRECTORY_PAGE = 2_000;

export type DirectoryEntry = { number: string; label: string };

/**
 * Caller ID ahead of time, for an iPhone (owner, 22 Oct 2026). iOS never lets an app look a ringing number up;
 * it asks a Call Directory extension the app has loaded beforehand. So the app is given every number this person
 * could be called from by a customer they may see — exactly whom `matchNumbers` would match: the contact's own
 * reach and their account's, still at the company, never a reseller's customer, a number of ten digits or more —
 * each as it is stored (the app writes it as iOS wants it), named "contact · company" as their screens show
 * them (field access covers leads, not contacts).
 *
 * One entry a contact, in an order that doesn't change between asks: their own accounts first, then primary
 * contacts, then by name — so where two contacts carry one number, the first is the one caller ID would name,
 * and the one to keep. At most `DIRECTORY_MAX`, and `truncated` when there were more.
 */
export async function directoryEntries(userId: string, max = DIRECTORY_MAX): Promise<{ entries: DirectoryEntry[]; truncated: boolean }> {
  const scope: Prisma.ContactWhereInput[] = [
    { phone: { not: null } },
    STILL_THERE,
    { company: { managedByResellerId: null } },
    await throughAccount(userId, "view"),
    await contactAccess(userId, "view"),
  ];
  const entries: DirectoryEntry[] = [];
  const whose: Prisma.ContactWhereInput[] = [{ company: { ownerUserId: userId } }, { company: { OR: [{ ownerUserId: null }, { ownerUserId: { not: userId } }] } }];
  for (const theirs of whose) {
    let after: string | null = null;
    for (;;) {
      const page: { id: string; name: string; phone: string | null; company: { name: string } }[] = await db.contact.findMany({
        where: { AND: [...scope, theirs] },
        orderBy: [{ isPrimary: "desc" }, { name: "asc" }, { id: "asc" }],
        ...(after ? { cursor: { id: after }, skip: 1 } : {}),
        take: DIRECTORY_PAGE,
        select: { id: true, name: true, phone: true, company: { select: { name: true } } },
      });
      for (const c of page) {
        // A number too short to be one caller ID matches.
        if (!c.phone || !phoneKey(c.phone)) continue;
        if (entries.length === max) return { entries, truncated: true };
        entries.push({ number: c.phone, label: `${c.name} · ${c.company.name}` });
      }
      if (page.length < DIRECTORY_PAGE) break;
      after = page[page.length - 1]!.id;
    }
  }
  return { entries, truncated: false };
}

const CLOSED: LeadStatus[] = ["WON", "LOST", "DISQUALIFIED"];

export type OpenLead = { id: string; ref: string | null; title: string; stage: string; contactId: string | null; ownerUserId: string | null; owner: string | null };

/** The company's open leads this person may see — none where leads aren't theirs to open. Titles as their field access shows them. */
export async function openLeadsFor(userId: string, companyId: string): Promise<OpenLead[]> {
  if ((await moduleAccessFor(userId, "leads")) !== "available") return [];
  const leads = await db.lead.findMany({
    where: { AND: [{ companyId, status: { notIn: CLOSED } }, await leadAccess(userId, "view")] },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { id: true, leadSeq: true, title: true, status: true, contactId: true, ownerUserId: true, stage: { select: { label: true } }, owner: { select: { name: true } } },
  });
  const shown = await leadsSeenBy(userId, leads.map((l) => ({ lead: { title: l.title } })));
  return leads.map((l, i) => ({
    id: l.id,
    ref: leadRef(l.leadSeq),
    title: (shown[i]?.lead as { title?: string } | null)?.title ?? l.title,
    stage: l.stage?.label ?? l.status.charAt(0) + l.status.slice(1).toLowerCase().replaceAll("_", " "),
    contactId: l.contactId,
    ownerUserId: l.ownerUserId,
    owner: l.owner?.name ?? null,
  }));
}

/**
 * The lead a call from the phone is about, when there is no doubt: the one open lead with this contact on
 * it, or else the one open lead at the company that is this person's. Anything less clear is left for
 * them to pick on the phone.
 */
export function obviousLead(userId: string, match: PhoneMatch, leads: OpenLead[]): string | null {
  const theirs = leads.filter((l) => l.contactId === match.contact.id);
  if (theirs.length === 1) return theirs[0]!.id;
  if (theirs.length > 1) return null;
  const mine = leads.filter((l) => l.ownerUserId === userId);
  return mine.length === 1 ? mine[0]!.id : null;
}

export type CallerCard = {
  contact: PhoneMatch["contact"];
  company: { id: string; ref: string | null; name: string };
  also_on: number;
  leads: Omit<OpenLead, "contactId" | "ownerUserId">[];
  last_call: { at: string | null; outcome: CallOutcome; direction: string; by: string } | null;
  callback_due: string | null;
};

/** What the phone shows while a number rings: who, which company, the open leads, the last call, a callback owed. */
export async function callerCard(userId: string, match: PhoneMatch): Promise<CallerCard> {
  const scope = { AND: [await throughAccount(userId, "view"), await callAccess(userId, "view")] };
  const [leads, last, due] = await Promise.all([
    openLeadsFor(userId, match.company.id),
    db.callLog.findFirst({
      where: { AND: [scope, { OR: [{ contactId: match.contact.id }, { companyId: match.company.id, contactId: null }] }] },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, outcome: true, direction: true, user: { select: { name: true } } },
    }),
    db.callLog.findFirst({
      where: { AND: [scope, { contactId: match.contact.id, followUpAt: { not: null }, followUpDone: false }] },
      orderBy: { followUpAt: "asc" },
      select: { followUpAt: true },
    }),
  ]);
  return {
    contact: match.contact,
    company: { id: match.company.id, ref: match.company.ref, name: match.company.name },
    also_on: match.alsoOn,
    leads: leads.slice(0, 3).map((l) => ({ id: l.id, ref: l.ref, title: l.title, stage: l.stage, owner: l.owner })),
    last_call: last ? { at: iso(last.startedAt), outcome: last.outcome, direction: last.direction === "INBOUND" ? "in" : "out", by: last.user.name } : null,
    callback_due: iso(due?.followUpAt),
  };
}
