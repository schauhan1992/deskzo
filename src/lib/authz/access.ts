import { cache } from "react";
import type { AccessLevel, CompanyRelationshipType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { permissionsFor } from "@/lib/authz/resolve";
import { getDownlineUserIds } from "@/lib/org-chart";
import { SUPPORT_READONLY_ROLE } from "@/lib/roles";
import { notMigratedYet } from "@/lib/not-migrated";
import { HEAD_OFFICE_ID } from "@/lib/branches/identity";
import { vendorRelationshipTypeValues } from "@/lib/validation/company";

/**
 * How far somebody reaches over a kind of record — the second of the three questions in
 * docs/permission-redesign.md. The first, *what may you do*, stays with permissions (`can`); this
 * answers *which of those records*.
 *
 * For each record type and action (view, edit, delete, assign) a person has a **level**:
 *
 *   NONE    nothing
 *   OWN     records whose own person is them (the account manager, the lead's owner…)
 *   TEAM    …them or anybody who reports to them, at any depth
 *   BRANCH  …anybody in their branch (or, for documents and payments, the record's own branch)
 *   ALL     every record
 *   FOLLOW  "as far as the account" — for records that hang off a company: you reach a contact,
 *           a lead, an order, a document or a payment exactly when you reach its company
 *
 * ## Where a level comes from — the first that answers is final
 *
 *   0. No such person, or the Automation account → NONE.
 *   1. Super admin            → ALL.
 *   2. Inactive               → NONE.
 *   3. Platform support on a read-only grant → view as derived below; edit, delete, assign NONE.
 *   4. The person's own level (`UserAccessLevel`, unexpired).
 *   5. Their role's level (`RoleAccessLevel`).
 *   6. **Derived from their permissions**, exactly as access worked before levels existed: companies
 *      and vendors are ALL with "See all companies" and TEAM without; a contact, lead, order,
 *      document or payment is FOLLOW with its view permission and NONE without. Edit, delete and
 *      assign derive the same as view, because before levels a write asked the same question a
 *      read did.
 *
 * Rule 6 is why levels shipped without changing anybody's access: until an admin stores a level,
 * every answer here is the one the old helpers gave (`scripts/access-snapshot.ts` proves it).
 *
 * ## You can only change what you can see
 *
 * Edit never reaches wider than view, and delete and assign never wider than edit. Rather than
 * clamping levels — FOLLOW has no place in the order — every fragment for an action is the AND of
 * its own level and the levels it sits under, collapsed when they are the same.
 *
 * ## Customers and vendors are separate rows
 *
 * One `Company` table holds both, split by `relationshipType` (`vendorRelationshipTypeValues`).
 * While the two levels are the same — always, until an admin sets one — every fragment is the same
 * single clause the old helpers wrote. When they differ the fragment splits by type, which is why a
 * single-company check must be told the company's type.
 *
 * ## Fail closed
 *
 * A stored level a record type doesn't offer (OWN on contacts, FOLLOW on companies) answers NONE:
 * only this module's own writers store levels, so such a row is corrupt, and corrupt access data
 * should hide rather than reveal. A workspace whose database hasn't got the level tables yet (new
 * code meets old databases for a while after a deploy) is treated as one with no levels stored.
 */

export const ACCESS_ACTIONS = ["view", "edit", "delete", "assign"] as const;
export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export const ACCESS_RECORD_KEYS = ["companies", "vendors", "contacts", "leads", "orders", "documents", "payments"] as const;
export type AccessRecord = (typeof ACCESS_RECORD_KEYS)[number];

/** The record types whose rows hang off an account, and so may FOLLOW it. */
type ChildRecord = Exclude<AccessRecord, "companies" | "vendors">;

type RecordDefinition = {
  key: AccessRecord;
  label: string;
  /** What "own" means for it, in the words the role screen uses. */
  ownMeans: string;
  /** The levels an admin may choose — anything else stored for it answers NONE. */
  levels: readonly AccessLevel[];
  /** The permission whose holders reach it today (rule 6). */
  derivedFrom: { key: string; held: AccessLevel; missing: AccessLevel };
};

const OWNED_LEVELS: readonly AccessLevel[] = ["NONE", "OWN", "TEAM", "BRANCH", "ALL"];
const CHILD_LEVELS: readonly AccessLevel[] = ["NONE", "OWN", "TEAM", "BRANCH", "ALL", "FOLLOW"];

export const ACCESS_RECORDS: readonly RecordDefinition[] = [
  {
    key: "companies",
    label: "Customers & companies",
    ownMeans: "the account manager",
    levels: OWNED_LEVELS,
    derivedFrom: { key: "companies.viewAll", held: "ALL", missing: "TEAM" },
  },
  {
    key: "vendors",
    label: "Vendors & distributors",
    ownMeans: "the account manager",
    levels: OWNED_LEVELS,
    derivedFrom: { key: "companies.viewAll", held: "ALL", missing: "TEAM" },
  },
  {
    key: "contacts",
    label: "Contacts",
    ownMeans: "— (contacts follow their company)",
    levels: ["NONE", "FOLLOW", "ALL"],
    derivedFrom: { key: "contacts.view", held: "FOLLOW", missing: "NONE" },
  },
  {
    key: "leads",
    label: "Leads",
    ownMeans: "the lead's owner",
    levels: CHILD_LEVELS,
    derivedFrom: { key: "leads.view", held: "FOLLOW", missing: "NONE" },
  },
  {
    key: "orders",
    label: "Orders & subscriptions",
    ownMeans: "the person who added it",
    levels: CHILD_LEVELS,
    derivedFrom: { key: "orders.view", held: "FOLLOW", missing: "NONE" },
  },
  {
    key: "documents",
    label: "Sales & purchase documents",
    ownMeans: "its salesperson or the person who raised it",
    levels: CHILD_LEVELS,
    derivedFrom: { key: "documents.view", held: "FOLLOW", missing: "NONE" },
  },
  {
    key: "payments",
    label: "Payments",
    ownMeans: "the person who recorded it",
    levels: CHILD_LEVELS,
    derivedFrom: { key: "payments.view", held: "FOLLOW", missing: "NONE" },
  },
];

const RECORD_BY_KEY = new Map(ACCESS_RECORDS.map((r) => [r.key, r]));

export function accessRecordDefinition(record: AccessRecord): RecordDefinition {
  return RECORD_BY_KEY.get(record)!;
}

export function isAccessRecord(value: string): value is AccessRecord {
  return RECORD_BY_KEY.has(value as AccessRecord);
}

export function isAccessAction(value: string): value is AccessAction {
  return (ACCESS_ACTIONS as readonly string[]).includes(value);
}

/** The actions an action sits under: you can't edit what you can't see, nor delete what you can't edit. */
const UNDER: Record<AccessAction, readonly AccessAction[]> = {
  view: [],
  edit: ["view"],
  delete: ["edit", "view"],
  assign: ["edit", "view"],
};

// ─── Resolution ───────────────────────────────────────────────────────────────────────────────────

export type AccessSource =
  | { via: "automation" }
  | { via: "superAdmin" }
  | { via: "inactive" }
  | { via: "supportReadOnly" }
  | { via: "userLevel"; reason: string | null; expiresAt: Date | null }
  | { via: "roleLevel"; role: string }
  | { via: "derived"; from: string; held: boolean };

export type ResolvedLevel = { level: AccessLevel; source: AccessSource };

type Person = {
  id: string;
  role: string;
  /** The branch whose records BRANCH reaches: their own while it is active, otherwise the head office. */
  branchId: string;
};

export type ResolvedAccess = {
  person: Person | null;
  levels: Map<string, ResolvedLevel>;
};

const slot = (record: AccessRecord, action: AccessAction) => `${record}:${action}`;

/** The two level tables, or none at all where this workspace hasn't been migrated to them yet. */
async function storedLevels(userId: string, role: string) {
  try {
    const [personal, forRole] = await Promise.all([
      db.userAccessLevel.findMany({
        where: { userId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { record: true, action: true, level: true, reason: true, expiresAt: true },
      }),
      db.roleAccessLevel.findMany({ where: { role }, select: { record: true, action: true, level: true } }),
    ]);
    return { personal, forRole };
  } catch (err) {
    if (notMigratedYet(err)) return { personal: [], forRole: [] };
    throw err;
  }
}

/**
 * Every level of one person, resolved once per request.
 *
 * React's `cache()` scopes it to one render, as `resolveUserPermissions` is — the sidebar, the page and
 * three actions in one request resolve once. Outside a request (scripts, check suites) nothing is
 * memoised, which is what lets a suite change a level and ask again.
 */
export const resolveAccess = cache(async (userId: string): Promise<ResolvedAccess> => {
  const levels = new Map<string, ResolvedLevel>();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, active: true, isSuperAdmin: true, kind: true, branchId: true, branch: { select: { active: true } } },
  });

  const everything = (level: AccessLevel, source: AccessSource) => {
    for (const record of ACCESS_RECORD_KEYS) for (const action of ACCESS_ACTIONS) levels.set(slot(record, action), { level, source });
  };

  if (!user || user.kind === "AUTOMATION") {
    everything("NONE", { via: "automation" });
    return { person: null, levels };
  }
  const person: Person = { id: user.id, role: user.role, branchId: user.branchId && user.branch?.active ? user.branchId : HEAD_OFFICE_ID };
  if (user.isSuperAdmin) {
    everything("ALL", { via: "superAdmin" });
    return { person, levels };
  }
  if (!user.active) {
    everything("NONE", { via: "inactive" });
    return { person, levels };
  }

  const held = new Set<string>((await permissionsFor(userId)).map(String));
  const derive = (record: AccessRecord): ResolvedLevel => {
    const { derivedFrom } = accessRecordDefinition(record);
    const has = held.has(derivedFrom.key);
    return { level: has ? derivedFrom.held : derivedFrom.missing, source: { via: "derived", from: derivedFrom.key, held: has } };
  };

  if (user.role === SUPPORT_READONLY_ROLE) {
    for (const record of ACCESS_RECORD_KEYS) {
      for (const action of ACCESS_ACTIONS) {
        levels.set(slot(record, action), action === "view" ? derive(record) : { level: "NONE", source: { via: "supportReadOnly" } });
      }
    }
    return { person, levels };
  }

  const { personal, forRole } = await storedLevels(userId, user.role);
  const personalBySlot = new Map(personal.map((r) => [`${r.record}:${r.action}`, r]));
  const roleBySlot = new Map(forRole.map((r) => [`${r.record}:${r.action}`, r]));
  const allowed = (record: AccessRecord, level: AccessLevel): AccessLevel =>
    accessRecordDefinition(record).levels.includes(level) ? level : "NONE";

  for (const record of ACCESS_RECORD_KEYS) {
    for (const action of ACCESS_ACTIONS) {
      const key = slot(record, action);
      const own = personalBySlot.get(key);
      if (own) {
        levels.set(key, { level: allowed(record, own.level), source: { via: "userLevel", reason: own.reason, expiresAt: own.expiresAt } });
        continue;
      }
      const fromRole = roleBySlot.get(key);
      if (fromRole) {
        levels.set(key, { level: allowed(record, fromRole.level), source: { via: "roleLevel", role: user.role } });
        continue;
      }
      levels.set(key, derive(record));
    }
  }
  return { person, levels };
});

/** One person's level for one record type and action, with where it came from. */
export async function explainAccess(userId: string, record: AccessRecord, action: AccessAction): Promise<ResolvedLevel> {
  const { levels } = await resolveAccess(userId);
  return levels.get(slot(record, action)) ?? { level: "NONE", source: { via: "automation" } };
}

/** One person's level for one record type and action. */
export async function accessLevel(userId: string, record: AccessRecord, action: AccessAction): Promise<AccessLevel> {
  return (await explainAccess(userId, record, action)).level;
}

// ─── Whose records a level reaches ────────────────────────────────────────────────────────────────

/** Everybody whose records count as this person's branch's: in it, or — for the head office — in none. */
const branchPeople = cache(async (branchId: string): Promise<string[]> => {
  const where: Prisma.UserWhereInput =
    branchId === HEAD_OFFICE_ID
      ? { OR: [{ branchId: null }, { branchId: HEAD_OFFICE_ID }, { branch: { active: false } }] }
      : { branchId };
  return (await db.user.findMany({ where, select: { id: true } })).map((u) => u.id);
});

/**
 * The people whose records a person-based level reaches, or null for every record.
 *
 * TEAM is the same reporting-line walk the old helpers made (`getDownlineUserIds`: transitive,
 * cycle-safe, active reports only), so a TEAM answer is the old answer to the id.
 */
async function reachedPeople(person: Person | null, level: AccessLevel): Promise<string[] | null> {
  if (!person) return [];
  switch (level) {
    case "ALL":
      return null;
    case "OWN":
      return [person.id];
    case "TEAM":
      return [person.id, ...(await getDownlineUserIds(person.id))];
    case "BRANCH":
      return branchPeople(person.branchId);
    default:
      return [];
  }
}

/** The branches a record-branch level reaches: the person's own, and for the head office, "none recorded". */
function branchWhere(person: Person | null): { branchId: string | null }[] {
  if (!person) return [];
  return person.branchId === HEAD_OFFICE_ID ? [{ branchId: HEAD_OFFICE_ID }, { branchId: null }] : [{ branchId: person.branchId }];
}

const NOTHING = { id: { in: [] as string[] } };

// ─── Accounts: customers and vendors ──────────────────────────────────────────────────────────────

const VENDOR_TYPES = [...vendorRelationshipTypeValues] as CompanyRelationshipType[];

/** Which of the two account rows a company is governed by. */
export function accountRecord(relationshipType: CompanyRelationshipType): "companies" | "vendors" {
  return VENDOR_TYPES.includes(relationshipType) ? "vendors" : "companies";
}

async function ownerClause(person: Person | null, level: AccessLevel): Promise<Prisma.CompanyWhereInput> {
  if (level === "NONE") return NOTHING;
  const ids = await reachedPeople(person, level);
  return ids === null ? {} : { ownerUserId: { in: ids } };
}

/** The companies this person reaches for one action, before the actions it sits under. */
async function accountClause(userId: string, action: AccessAction): Promise<Prisma.CompanyWhereInput> {
  const { person, levels } = await resolveAccess(userId);
  const customers = levels.get(slot("companies", action))!.level;
  const vendors = levels.get(slot("vendors", action))!.level;
  if (customers === vendors) return ownerClause(person, customers);
  return {
    OR: [
      { AND: [{ relationshipType: { in: VENDOR_TYPES } }, await ownerClause(person, vendors)] },
      { AND: [{ relationshipType: { notIn: VENDOR_TYPES } }, await ownerClause(person, customers)] },
    ],
  };
}

/** The AND of a fragment and the fragments of the actions it sits under, collapsed when they agree. */
async function under<W extends object>(
  userId: string,
  record: AccessRecord,
  action: AccessAction,
  clauseFor: (action: AccessAction) => Promise<W>,
): Promise<W> {
  const { levels } = await resolveAccess(userId);
  const mine = levels.get(slot(record, action))!.level;
  const parts: W[] = [await clauseFor(action)];
  const seen = new Set<string>([mine]);
  for (const parent of UNDER[action]) {
    const level = levels.get(slot(record, parent))!.level;
    // Same level, same clause — unless it follows the account, whose own action may differ.
    if (seen.has(level) && level !== "FOLLOW") continue;
    seen.add(level);
    parts.push(await clauseFor(parent));
  }
  const distinct = parts.filter((p, i) => parts.findIndex((q) => JSON.stringify(q) === JSON.stringify(p)) === i);
  const narrowing = distinct.filter((p) => Object.keys(p).length > 0);
  if (narrowing.length === 0) return {} as W;
  if (narrowing.length === 1) return narrowing[0]!;
  return { AND: narrowing } as W;
}

/** For a query on `Company`: the customers and vendors this person may act on this way. */
export async function companyAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.CompanyWhereInput> {
  // Customers and vendors are judged together: `under` runs per account row, so the AND covers both.
  const forAction = (a: AccessAction) => accountClause(userId, a);
  const { levels } = await resolveAccess(userId);
  const parts: Prisma.CompanyWhereInput[] = [await forAction(action)];
  for (const parent of UNDER[action]) {
    const same =
      levels.get(slot("companies", parent))!.level === levels.get(slot("companies", action))!.level &&
      levels.get(slot("vendors", parent))!.level === levels.get(slot("vendors", action))!.level;
    if (!same) parts.push(await forAction(parent));
  }
  const narrowing = parts.filter((p) => Object.keys(p).length > 0);
  if (narrowing.length === 0) return {};
  if (narrowing.length === 1) return narrowing[0]!;
  return { AND: narrowing };
}

/**
 * For anything with a `company` relation: the rows whose company this person reaches — or no
 * condition at all when they reach every company, so an unrestricted query stays as it always was.
 */
export async function throughAccount(userId: string, action: AccessAction = "view"): Promise<{ company?: Prisma.CompanyWhereInput }> {
  const where = await companyAccess(userId, action);
  return Object.keys(where).length === 0 ? {} : { company: where };
}

/** The facts a single-company check needs. */
export type AccountFacts = { ownerUserId: string | null; relationshipType: CompanyRelationshipType };

async function reachesAccountFor(userId: string, action: AccessAction, account: AccountFacts): Promise<boolean> {
  const { person, levels } = await resolveAccess(userId);
  const level = levels.get(slot(accountRecord(account.relationshipType), action))!.level;
  if (level === "NONE") return false;
  const ids = await reachedPeople(person, level);
  if (ids === null) return true;
  return account.ownerUserId !== null && ids.includes(account.ownerUserId);
}

/** Whether this person may act this way on one company — the single-record twin of `companyAccess`. */
export async function mayAccessAccount(userId: string, action: AccessAction, account: AccountFacts): Promise<boolean> {
  if (!(await reachesAccountFor(userId, action, account))) return false;
  for (const parent of UNDER[action]) if (!(await reachesAccountFor(userId, parent, account))) return false;
  return true;
}

// ─── Records that hang off an account ─────────────────────────────────────────────────────────────

/**
 * How each child record's own level is expressed: who its own person is, and where its branch comes
 * from. Contacts have no own person — they offer only NONE, FOLLOW and ALL.
 */
type ChildShape = {
  /** Clause for "its own person is one of these". */
  ownedBy: (ids: string[]) => object;
  /** Clause for "in this person's branch": the record's own branch, or its own person's. */
  inBranch: (person: Person) => Promise<object>;
};

const peopleBranch = async (person: Person, field: string): Promise<object> => ({ [field]: { in: await branchPeople(person.branchId) } });
const ownBranch = async (person: Person): Promise<object> => ({ OR: branchWhere(person) });

const CHILD_SHAPES: Record<ChildRecord, ChildShape> = {
  contacts: { ownedBy: () => NOTHING, inBranch: async () => NOTHING },
  leads: { ownedBy: (ids) => ({ ownerUserId: { in: ids } }), inBranch: (p) => peopleBranch(p, "ownerUserId") },
  orders: { ownedBy: (ids) => ({ addedByUserId: { in: ids } }), inBranch: (p) => peopleBranch(p, "addedByUserId") },
  documents: {
    ownedBy: (ids) => ({ OR: [{ salespersonId: { in: ids } }, { createdById: { in: ids } }] }),
    inBranch: ownBranch,
  },
  payments: { ownedBy: (ids) => ({ recordedByUserId: { in: ids } }), inBranch: ownBranch },
};

async function childClause(userId: string, record: ChildRecord, action: AccessAction): Promise<object> {
  const { person, levels } = await resolveAccess(userId);
  const level = levels.get(slot(record, action))!.level;
  const shape = CHILD_SHAPES[record];
  switch (level) {
    case "NONE":
      return NOTHING;
    case "ALL":
      return {};
    case "FOLLOW":
      return throughAccount(userId, action);
    case "BRANCH":
      return person ? shape.inBranch(person) : NOTHING;
    default: {
      const ids = await reachedPeople(person, level);
      return ids === null ? {} : shape.ownedBy(ids);
    }
  }
}

async function childAccess(userId: string, record: ChildRecord, action: AccessAction): Promise<object> {
  return under(userId, record, action, (a) => childClause(userId, record, a));
}

/** For a query on `Contact`. */
export async function contactAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.ContactWhereInput> {
  return (await childAccess(userId, "contacts", action)) as Prisma.ContactWhereInput;
}

/** For a query on `Lead`. */
export async function leadAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.LeadWhereInput> {
  return (await childAccess(userId, "leads", action)) as Prisma.LeadWhereInput;
}

/** For a query on `CompanyProduct` — orders, subscriptions and renewals. */
export async function orderAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.CompanyProductWhereInput> {
  return (await childAccess(userId, "orders", action)) as Prisma.CompanyProductWhereInput;
}

/** For a query on `TradeDocument`. */
export async function documentAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.TradeDocumentWhereInput> {
  return (await childAccess(userId, "documents", action)) as Prisma.TradeDocumentWhereInput;
}

/** For a query on `Payment`. */
export async function paymentAccess(userId: string, action: AccessAction = "view"): Promise<Prisma.PaymentWhereInput> {
  return (await childAccess(userId, "payments", action)) as Prisma.PaymentWhereInput;
}

/**
 * Whether this person may act this way on one company's contacts — for the contact actions, which
 * know the company rather than a contact id. Contacts offer NONE, FOLLOW and ALL, so the answer is
 * nobody's, the account's, or everybody's — each checked under the actions it sits beneath.
 */
export async function mayAccessContactsOf(userId: string, action: AccessAction, account: AccountFacts): Promise<boolean> {
  const { levels } = await resolveAccess(userId);
  for (const a of [action, ...UNDER[action]]) {
    const level = levels.get(slot("contacts", a))!.level;
    if (level === "NONE") return false;
    if (level === "FOLLOW" && !(await mayAccessAccount(userId, a, account))) return false;
  }
  return true;
}

/**
 * Whether this person may act this way on one record, by id — the single-record twin of the
 * fragments above, asked of the same fragment so a list and a detail page can never disagree.
 */
export async function mayAccess(userId: string, record: AccessRecord, action: AccessAction, id: string): Promise<boolean> {
  switch (record) {
    case "companies":
    case "vendors":
      return (await db.company.count({ where: { AND: [{ id }, await companyAccess(userId, action)] } })) > 0;
    case "contacts":
      return (await db.contact.count({ where: { AND: [{ id }, await contactAccess(userId, action)] } })) > 0;
    case "leads":
      return (await db.lead.count({ where: { AND: [{ id }, await leadAccess(userId, action)] } })) > 0;
    case "orders":
      return (await db.companyProduct.count({ where: { AND: [{ id }, await orderAccess(userId, action)] } })) > 0;
    case "documents":
      return (await db.tradeDocument.count({ where: { AND: [{ id }, await documentAccess(userId, action)] } })) > 0;
    case "payments":
      return (await db.payment.count({ where: { AND: [{ id }, await paymentAccess(userId, action)] } })) > 0;
  }
}

/**
 * The account managers whose customers this person reaches for viewing, or null for all of them —
 * for the reports, forecasts and exports that narrow by account manager directly. Customers only:
 * those screens are about selling, and a level set apart for vendors is not theirs to widen or narrow.
 */
export async function customerReachIds(userId: string): Promise<string[] | null> {
  const { person, levels } = await resolveAccess(userId);
  const level = levels.get(slot("companies", "view"))!.level;
  if (level === "NONE") return [];
  return reachedPeople(person, level);
}
