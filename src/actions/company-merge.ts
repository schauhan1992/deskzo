"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { canViewContacts, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { parseRecordRef } from "@/lib/record-url";
import { formatCompanyId } from "@/lib/order-id";
import { normalizeCompanyName } from "@/lib/company-name";
import { isFreeMailbox } from "@/lib/email-verification";
import { checkTerms, recordDecision } from "@/lib/credit/guard";
import { assessCompanies, cacheAssessments } from "@/lib/credit/load";
import { companyFamily, domainOf, duplicatePairs, pairKey, phoneKey, type DuplicateCandidate } from "@/lib/companies/duplicates";
import { executeMerge, MergeRefused, planMerge, type MergePlan } from "@/lib/companies/merge";
import type { ActionResult } from "@/actions/company";

/**
 * Merging duplicate companies, and the list of likely duplicates — see src/lib/companies/merge.ts
 * for what a merge does and src/lib/companies/duplicates.ts for how duplicates are found.
 *
 * All of it needs `companies.merge`, and only ever between companies the person can already see:
 * a merge must not be a way to reach an account through a duplicate of it.
 */

const NOT_ALLOWED = "You can't merge companies.";

async function companyByRef(segment: string) {
  const ref = parseRecordRef(segment);
  return db.company.findUnique({
    where: ref.kind === "seq" ? { companySeq: ref.seq } : { id: ref.id },
    select: { id: true, companySeq: true, name: true, ownerUserId: true },
  });
}

/** A company this person may see, by COM number or id — null for "not there" and "not yours" alike. */
async function visibleCompany(userId: string, segment: string) {
  const company = await companyByRef(segment);
  return company && (await canSeeCompany(userId, company.ownerUserId)) ? company : null;
}

export type MergeScreen = {
  plan: MergePlan;
  /** Which choices this person may make — the screen says so rather than failing at the end. */
  may: { reassign: boolean; overrideCredit: boolean };
};

/**
 * The merge screen for a pair, or the one company when the other hasn't been picked yet. `keep` is
 * the company that stays.
 */
export async function getMergeScreen(keepRef: string, dropRef: string): Promise<ActionResult<MergeScreen>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const [keep, drop] = await Promise.all([visibleCompany(user.id, keepRef), visibleCompany(user.id, dropRef)]);
  if (!keep || !drop) return { ok: false, error: "Company not found." };
  const plan = await planMerge(keep.id, drop.id);
  if (!plan) return { ok: false, error: "Company not found." };

  const [reassign, overrideCredit, seesContacts, seesRestricted] = await Promise.all([
    can(user.id, "accounts.reassign"),
    hasEffectivePermission(user.id, "credit.override"),
    canViewContacts(user.id),
    seesResellerContactDetails(user.id),
  ]);
  // The same rule as the company page: without contacts.view nobody's details show, and a reseller's
  // end customer's show only with contacts.viewRestricted. The pairs are still listed, by name.
  const restricted = (await db.company.count({ where: { id: { in: [keep.id, drop.id] }, managedByResellerId: { not: null } } })) > 0;
  if (!seesContacts || (restricted && !seesRestricted)) {
    for (const s of [plan.keep, plan.drop]) s.contacts = s.contacts.map((c) => ({ ...c, email: null, phone: null }));
    plan.contactPairs = plan.contactPairs.map((p) => ({ ...p, reason: p.reason.startsWith("Same email") ? "Same email" : p.reason.replace(/ …\d+/, "") }));
  }
  return { ok: true, data: toPlain({ plan, may: { reassign, overrideCredit } }) };
}

const mergeSchema = z.object({
  keepId: z.string().min(1),
  dropId: z.string().min(1),
  choices: z.record(z.string(), z.enum(["keep", "drop"])).default({}),
  combine: z.array(z.string()).max(2000).default([]),
  /** The duplicate's name, typed — there is no undo. */
  confirmName: z.string(),
});

export async function mergeCompanies(input: unknown): Promise<ActionResult<{ ref: string }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  const parsed = mergeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { keepId, dropId, choices, combine, confirmName } = parsed.data;

  const [keep, drop] = await Promise.all([
    db.company.findUnique({ where: { id: keepId } }),
    db.company.findUnique({ where: { id: dropId } }),
  ]);
  if (!keep || !drop || !(await canSeeCompany(user.id, keep.ownerUserId)) || !(await canSeeCompany(user.id, drop.ownerUserId))) {
    return { ok: false, error: "Company not found — it may have been merged already." };
  }
  if (normalizeCompanyName(confirmName) !== normalizeCompanyName(drop.name)) {
    return { ok: false, error: `Type "${drop.name}" exactly to confirm — it is the company that will be removed.` };
  }

  // Choices that are changes in their own right need the right to make them on their own.
  const takes = (key: string) => choices[key] === "drop";
  if ((takes("ownerUserId") && drop.ownerUserId !== keep.ownerUserId) || (takes("assignedToUserId") && drop.assignedToUserId !== keep.assignedToUserId)) {
    if (!(await can(user.id, "accounts.reassign"))) return { ok: false, error: "Keeping the other company's account manager or caller is reassigning the account, which you can't do. Keep this one's." };
  }
  if (takes("creditLimit") && String(drop.creditLimit) !== String(keep.creditLimit) && !(await hasEffectivePermission(user.id, "credit.override"))) {
    return { ok: false, error: "Only someone who can set credit limits can keep the other company's limit." };
  }
  const keepRef = formatCompanyId(keep.companySeq);
  const dropRef = formatCompanyId(drop.companySeq);
  let termsDecision: Awaited<ReturnType<typeof checkTerms>> | null = null;
  if (takes("paymentTerms") && drop.paymentTerms !== keep.paymentTerms) {
    termsDecision = await checkTerms({
      userId: user.id,
      companyId: keep.id,
      relationshipType: keep.relationshipType,
      terms: drop.paymentTerms,
      previousTerms: keep.paymentTerms,
      reason: `Kept from ${dropRef} ${drop.name} when it was merged into ${keepRef}.`,
      subject: "Default terms",
    });
    if (!termsDecision.ok) return { ok: false, error: termsDecision.error };
  }

  let outcome: Awaited<ReturnType<typeof executeMerge>>;
  try {
    outcome = await executeMerge({ keepId, dropId, choices, combine, userId: user.id });
  } catch (err) {
    if (err instanceof MergeRefused) return { ok: false, error: err.message };
    throw err;
  }

  const movedCount = outcome.moved.reduce((t, m) => t + m.count, 0);
  const merged = await db.company.findUnique({ where: { id: keep.id }, select: { name: true, companySeq: true, ownerUserId: true } });
  const label = merged?.name ?? keep.name;
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Company", entityId: drop.id, entityLabel: `${dropRef} ${drop.name} — merged into ${keepRef}` });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: keep.id, entityLabel: `${label} — ${dropRef} ${drop.name} merged into it, ${movedCount} records moved` });
  if (termsDecision?.ok && termsDecision.decision) await recordDecision({ userId: user.id, companyId: keep.id, kind: "TERMS", ...termsDecision.decision });

  // The rating came from half the payment history; work it out again from all of it now.
  await cacheAssessments(await assessCompanies([keep.id])).catch((err) => console.error("re-rating after merge failed", err));

  // Whoever looked after the duplicate hears where it went — it has vanished from their list.
  const told = new Set([user.id]);
  for (const person of [drop.ownerUserId, drop.assignedToUserId, merged?.ownerUserId]) {
    if (!person || told.has(person)) continue;
    told.add(person);
    await notifyUser({
      userId: person,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: `${dropRef} ${drop.name} was merged into ${keepRef} ${label}`,
      message: `${dropRef} was a duplicate of ${keepRef}. Its contacts, leads, orders, invoices, tickets and everything else are under ${label} now, and its old links open it.`,
      link: `/companies/${keepRef}`,
    });
  }

  revalidatePath("/companies");
  revalidatePath("/customers");
  revalidatePath("/vendors");
  revalidatePath("/resellers");
  revalidatePath("/commission-parties");
  revalidatePath("/companies/duplicates");
  revalidatePath(`/companies/${keepRef}`);
  return { ok: true, data: { ref: keepRef } };
}

// ─── The duplicates list ─────────────────────────────────────────────────────

export type DuplicateRow = {
  strength: "strong" | "likely";
  reasons: string[];
  /** The one suggested to keep first: more history under it, else the older record. */
  companies: { id: string; ref: string; name: string; kind: string; place: string | null; manager: string | null; records: number }[];
};

/** Likely duplicates among the companies this person can see, strongest first. */
export async function listDuplicates(): Promise<ActionResult<{ rows: DuplicateRow[]; scanned: number }>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };

  const [companies, dismissals] = await Promise.all([
    db.company.findMany({
      where: await companyScope(user.id),
      select: {
        id: true,
        companySeq: true,
        name: true,
        relationshipType: true,
        managedByResellerId: true,
        panNumber: true,
        website: true,
        owner: { select: { name: true } },
        locations: { select: { gstNumber: true, city: true, isPrimary: true } },
        contacts: { select: { email: true, phone: true } },
        _count: { select: { contacts: true, leads: true, products: true, tradeDocuments: true, payments: true, tickets: true } },
      },
    }),
    db.companyDuplicateDismissal.findMany({ select: { companyAId: true, companyBId: true } }),
  ]);

  const candidates: DuplicateCandidate[] = companies.map((c) => {
    const domains = new Set<string>();
    const site = c.website ? domainOf(c.website) : null;
    if (site) domains.add(site);
    for (const x of c.contacts) {
      const d = x.email ? domainOf(x.email) : null;
      if (d && !isFreeMailbox(d)) domains.add(d);
    }
    return {
      id: c.id,
      name: c.name,
      family: companyFamily(c.relationshipType),
      managedByResellerId: c.managedByResellerId,
      gstins: [...new Set(c.locations.map((l) => l.gstNumber?.trim().toUpperCase()).filter((g): g is string => !!g))],
      pan: c.panNumber?.trim().toUpperCase() || null,
      domains: [...domains],
      phones: [...new Set(c.contacts.map((x) => (x.phone ? phoneKey(x.phone) : null)).filter((p): p is string => !!p))],
    };
  });

  const byId = new Map(companies.map((c) => [c.id, c]));
  const records = (c: (typeof companies)[number]) => Object.values(c._count).reduce((t, n) => t + n, 0);
  const summary = (c: (typeof companies)[number]) => {
    const primary = c.locations.find((l) => l.isPrimary) ?? c.locations[0];
    return {
      id: c.id,
      ref: formatCompanyId(c.companySeq),
      name: c.name,
      kind: c.relationshipType.charAt(0) + c.relationshipType.slice(1).toLowerCase().replace(/_/g, " "),
      place: primary?.city ?? null,
      manager: c.owner?.name ?? null,
      records: records(c),
    };
  };

  const pairs = duplicatePairs(candidates, new Set(dismissals.map((d) => pairKey(d.companyAId, d.companyBId))));
  const rows = pairs.slice(0, 300).map((p) => {
    const [a, b] = [byId.get(p.aId)!, byId.get(p.bId)!];
    const aFirst = records(a) !== records(b) ? records(a) > records(b) : a.companySeq < b.companySeq;
    return { strength: p.strength, reasons: p.reasons, companies: (aFirst ? [a, b] : [b, a]).map(summary) };
  });
  return { ok: true, data: toPlain({ rows, scanned: companies.length }) };
}

/** "These two are not the same company" — the list stops offering the pair. */
export async function dismissDuplicate(aId: string, bId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await can(user.id, "companies.merge"))) return { ok: false, error: NOT_ALLOWED };
  if (typeof aId !== "string" || typeof bId !== "string" || aId === bId) return { ok: false, error: "Pick two companies." };
  const [a, b] = await Promise.all([visibleCompany(user.id, aId), visibleCompany(user.id, bId)]);
  if (!a || !b) return { ok: false, error: "Company not found." };
  const [companyAId, companyBId] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  await db.companyDuplicateDismissal.upsert({
    where: { companyAId_companyBId: { companyAId, companyBId } },
    create: { companyAId, companyBId, dismissedById: user.id },
    update: {},
  });
  revalidatePath("/companies/duplicates");
  return { ok: true, data: null };
}
