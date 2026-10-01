import { Prisma, type AttributionSource } from "@deskzo/control-client";
import { partnerAudit, actorRef, type PartnerActor } from "@/lib/partners/audit";
import { activeDealFor, cleanReferralCode, emailDomain, findActiveReferral } from "@/lib/partners/referrals";
import { actorOf, cleanId, mailPartnerUsers, requiredText } from "@/lib/partners/registry";
import { termsAt } from "@/lib/partners/terms";
import { PartnerRefused } from "@/lib/partners/types";
import { partnerOrigin } from "@/lib/partners/users";
import { controlDb } from "@/lib/platform/control-db";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * Which partner a workspace belongs to (tenant_attributions), from when to when, and how.
 *
 * At signup (spec §4.1) the claims are weighed in a fixed order — an approved deal registration for
 * the email's domain, then the partner's invitation code used, then the referral code on the form,
 * then a territory default — and the first present wins. Every other claim naming a different partner
 * is kept as a conflict, and a winner outside its territories is flagged, for staff to review; the
 * portal never sees either. No claim: the workspace is direct and nothing is written.
 *
 * After signup only staff move a workspace (§4.4): effective from now, with a reason, the old row
 * closed and a new one opened, both partners told in their activity logs. Nothing is ever backdated,
 * and commission follows the row in force when each invoice was paid (`attributionAt`).
 *
 * `tenants.partnerId` is kept in step with the current row, in the same transaction.
 */

export type SignupClaims = { inviteCodeHash: string | null; referralCode: string | null; email: string; country: string };

export type AttributionFlags = { outsideTerritory?: true; conflicts?: { partnerId: string; source: AttributionSource }[] };

/**
 * What signup decided. `dealId` is the winning deal registration (marked WON). `referralLinkId` is
 * the live referral link whose code was on the form — **whether or not it won**: its `signups`
 * counts every verified signup that carried it (spec §2.1), so `recordSignupAttribution` counts it
 * from here; no second argument is needed.
 */
export type AttributionDecision = {
  partnerId: string;
  source: Exclude<AttributionSource, "STAFF">;
  reference: string;
  commissionable: true;
  flags: AttributionFlags | null;
  dealId: string | null;
  referralLinkId: string | null;
};

type Claim = { partnerId: string; source: Exclude<AttributionSource, "STAFF">; reference: string };

/** The invitation's partner, when the code is a partner's and that partner is ACTIVE. */
async function inviteClaim(codeHash: string): Promise<Claim | null> {
  const hash = String(codeHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const invite = await controlDb().signupInvite.findUnique({ where: { codeHash: hash }, select: { partnerId: true, partner: { select: { status: true } } } });
  if (!invite?.partnerId || invite.partner?.status !== "ACTIVE") return null;
  return { partnerId: invite.partnerId, source: "SIGNUP_INVITE", reference: `invite:${hash.slice(0, 8)}` };
}

/** Exactly one ACTIVE distributor whose terms in force set a territory rate and whose territories hold the country; a tie is nobody. */
async function territoryClaim(country: string, now: Date): Promise<Claim | null> {
  const candidates = await controlDb().partner.findMany({ where: { status: "ACTIVE", kind: "DISTRIBUTOR", territories: { has: country } }, select: { id: true } });
  const holders: string[] = [];
  for (const c of candidates) {
    const terms = await termsAt(c.id, now);
    if (terms && terms.territoryRateBp !== null) holders.push(c.id);
    if (holders.length > 1) return null;
  }
  return holders.length === 1 ? { partnerId: holders[0]!, source: "TERRITORY", reference: `territory:${country}` } : null;
}

/**
 * The attribution a signup earns (spec §4.1), or null for a direct one. Called by verifySignup after
 * the invitation is spent and before the workspace is made. Reads only.
 */
export async function resolveSignupAttribution(claims: SignupClaims, now: Date = new Date()): Promise<AttributionDecision | null> {
  const country = String(claims?.country ?? "").trim().toUpperCase();
  const domain = emailDomain(String(claims?.email ?? ""));
  const referralCode = cleanReferralCode(claims?.referralCode);

  const deal = domain ? await activeDealFor(domain, now) : null;
  const invite = claims?.inviteCodeHash ? await inviteClaim(claims.inviteCodeHash) : null;
  const referral = referralCode ? await findActiveReferral(referralCode, now) : null;

  const present: Claim[] = [];
  if (deal) present.push({ partnerId: deal.partnerId, source: "DEAL_REGISTRATION", reference: `deal:${deal.id}` });
  if (invite) present.push(invite);
  if (referral) present.push({ partnerId: referral.partnerId, source: "REFERRAL_LINK", reference: `link:${referral.code}` });

  const winner = present[0] ?? (/^[A-Z]{2}$/.test(country) ? await territoryClaim(country, now) : null);
  if (!winner) return null;

  const flags: AttributionFlags = {};
  const conflicts = present.filter((c) => c !== winner && c.partnerId !== winner.partnerId).map(({ partnerId, source }) => ({ partnerId, source }));
  if (conflicts.length) flags.conflicts = conflicts;
  if (winner.source !== "TERRITORY") {
    const partner = await controlDb().partner.findUnique({ where: { id: winner.partnerId }, select: { territories: true } });
    if (partner && !partner.territories.includes(country)) flags.outsideTerritory = true;
  }
  return {
    partnerId: winner.partnerId,
    source: winner.source,
    reference: winner.reference.slice(0, 80),
    commissionable: true,
    flags: flags.conflicts || flags.outsideTerritory ? flags : null,
    dealId: winner.source === "DEAL_REGISTRATION" && deal ? deal.id : null,
    referralLinkId: referral?.linkId ?? null,
  };
}

const SIGNUP_ACTOR: PartnerActor = { kind: "system", name: "signup" };

/** One more verified signup carried a referral code — for a caller that has the code and no decision. */
export async function countReferralSignup(tx: Prisma.TransactionClient, code: string): Promise<void> {
  const key = cleanReferralCode(code);
  if (key) await tx.partnerReferralLink.updateMany({ where: { code: key }, data: { signups: { increment: 1 } } });
}

/**
 * Writes signup's decision inside the provisioning transaction (src/lib/platform/provisioning.ts):
 * the attribution row (`createdBy "signup"`), `tenants.partnerId`, the deal WON, the referral link's
 * `signups` + 1 (also when its code lost), the platform audit `partner.attribution.signup` (SYSTEM,
 * "signup" — the one platform row a partner library writes, as no console action is involved) and
 * the partner audit `customer.signup`. A partner gone since the decision leaves the workspace direct.
 * The email to the partner is `mailNewCustomer`, after the transaction.
 */
export async function recordSignupAttribution(tx: Prisma.TransactionClient, tenantId: string, decision: AttributionDecision, now: Date = new Date()): Promise<{ attributionId: string; partnerSlug: string } | null> {
  if (decision.referralLinkId) await tx.partnerReferralLink.updateMany({ where: { id: decision.referralLinkId }, data: { signups: { increment: 1 } } });
  const partner = await tx.partner.findUnique({ where: { id: decision.partnerId }, select: { id: true, slug: true } });
  if (!partner) return null;
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { id: true, name: true } });
  const flags = decision.flags && (decision.flags.conflicts?.length || decision.flags.outsideTerritory) ? decision.flags : null;
  const row = await tx.tenantAttribution.create({
    data: {
      tenantId: tenant.id,
      partnerId: partner.id,
      source: decision.source,
      reference: String(decision.reference ?? "").slice(0, 80) || null,
      commissionable: true,
      // SQL NULL when nothing is flagged: the console's review badge counts rows whose flags are not null.
      flags: flags ? (flags as Prisma.InputJsonValue) : Prisma.DbNull,
      validFrom: now,
      createdBy: "signup",
    },
    select: { id: true },
  });
  await tx.tenant.update({ where: { id: tenant.id }, data: { partnerId: partner.id }, select: { id: true } });
  if (decision.dealId) {
    const won = await tx.dealRegistration.updateMany({ where: { id: decision.dealId, partnerId: partner.id, status: "APPROVED" }, data: { status: "WON", tenantId: tenant.id } });
    if (won.count) await partnerAudit(SIGNUP_ACTOR, partner.id, "deal.won", "deal", decision.dealId, { workspace: tenant.name }, { tx });
  }
  await tx.platformAuditLog.create({
    data: { actorKind: "SYSTEM", actor: "signup", action: "partner.attribution.signup", tenantId: tenant.id, detail: { partner: partner.slug, source: decision.source, flagged: !!flags } },
  });
  await partnerAudit(SIGNUP_ACTOR, partner.id, "customer.signup", "workspace", tenant.id, { workspace: tenant.name, source: decision.source }, { tx });
  return { attributionId: row.id, partnerSlug: partner.slug };
}

const SOURCE_WORDS: Record<Exclude<AttributionSource, "STAFF">, string> = {
  DEAL_REGISTRATION: "from your deal registration",
  SIGNUP_INVITE: "with one of your invitation codes",
  REFERRAL_LINK: "through one of your referral links",
  TERRITORY: "from your territory",
};

/**
 * "A new customer signed up", to the winning partner's ADMIN and SALES users — after provisioning's
 * transaction. The workspace's name only: never the owner's address. Never throws.
 */
export async function mailNewCustomer(decision: AttributionDecision, tenantName: string): Promise<void> {
  try {
    const name = String(tenantName ?? "").trim().slice(0, 120) || "A new workspace";
    await mailPartnerUsers(decision.partnerId, { roles: ["ADMIN", "SALES"] }, "Partner portal: a new customer signed up", [
      `${name} has just signed up ${SOURCE_WORDS[decision.source]}, and is now one of your customers.`,
      "",
      `See it in the partner portal: ${partnerOrigin()}/customers`,
    ]);
  } catch (err) {
    console.error(`[partners] "a new customer signed up" could not be sent: ${err instanceof Error ? err.name : "error"}`);
  }
}

// ─── Staff moving a workspace ────────────────────────────────────────────────────────────────────

/**
 * Moves a workspace to a partner, or makes it direct (`partnerId` null) — console SELLERS, or the
 * CLI as `{ kind: "script" }`. Effective now (never backdated): the current row is closed and a STAFF
 * row opened, in one transaction with `tenants.partnerId`. Refused for a terminated partner, and for
 * the same partner with the same `commissionable` ("Nothing to change."). Outside the partner's
 * territories is allowed (the console's dialog warns first); `outsideTerritory` says so.
 *
 * The partner audit tells both partners — the old one `customer.removed`, the new one
 * `customer.assigned` — with the workspace's name alone (never the reason, never the other
 * partner). The caller writes the platform audit `partner.attribution` from what this returns.
 */
export async function setAttribution(
  tenantId: string,
  input: { partnerId: string | null; reason: string; commissionable: boolean },
  actor: Staff | PartnerActor,
  now: Date = new Date(),
): Promise<{ from: string | null; to: string | null; workspace: string; tenantSlug: string; commissionable: boolean; outsideTerritory: boolean; attributionId: string }> {
  const tid = cleanId(tenantId);
  const reason = requiredText(input?.reason, 10, 500, "Give a reason (10 to 500 characters).");
  const pid = input?.partnerId === null || input?.partnerId === undefined || String(input.partnerId).trim() === "" ? null : cleanId(input.partnerId);
  const commissionable = pid ? input?.commissionable !== false : true;
  const who = actorOf(actor);
  if (!tid) throw new PartnerRefused("That workspace no longer exists.");

  return controlDb().$transaction(async (tx) => {
    // One change to a workspace's partner at a time: two at once would both close the same row.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenants WHERE id = ${tid} FOR UPDATE`;
    if (!locked[0]) throw new PartnerRefused("That workspace no longer exists.");
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tid }, select: { id: true, name: true, slug: true, country: true } });
    const current = await tx.tenantAttribution.findFirst({
      where: { tenantId: tid, validTo: null },
      select: { id: true, partnerId: true, commissionable: true, validFrom: true, partner: { select: { slug: true } } },
    });
    const next = pid ? await tx.partner.findUnique({ where: { id: pid }, select: { id: true, slug: true, status: true, territories: true } }) : null;
    if (pid && !next) throw new PartnerRefused("That partner no longer exists.");
    if (next?.status === "TERMINATED") throw new PartnerRefused("A terminated partner can't be given customers.");
    const fromId = current?.partnerId ?? null;
    if (fromId === pid && (pid === null || current?.commissionable === commissionable)) throw new PartnerRefused("Nothing to change.");

    if (current) await tx.tenantAttribution.update({ where: { id: current.id }, data: { validTo: current.validFrom > now ? current.validFrom : now }, select: { id: true } });
    const row = await tx.tenantAttribution.create({
      data: { tenantId: tid, partnerId: pid, source: "STAFF", reference: null, reason, commissionable, flags: Prisma.DbNull, validFrom: now, createdBy: actorRef(who) },
      select: { id: true },
    });
    await tx.tenant.update({ where: { id: tid }, data: { partnerId: pid }, select: { id: true } });
    if (fromId && fromId !== pid) await partnerAudit(who, fromId, "customer.removed", "workspace", tid, { workspace: tenant.name }, { tx });
    if (pid) await partnerAudit(who, pid, "customer.assigned", "workspace", tid, { workspace: tenant.name }, { tx });
    return {
      from: current?.partner?.slug ?? null,
      to: next?.slug ?? null,
      workspace: tenant.name,
      tenantSlug: tenant.slug,
      commissionable,
      outsideTerritory: !!next && !next.territories.includes(tenant.country),
      attributionId: row.id,
    };
  });
}

/**
 * Staff looked at a flagged current attribution (console, SELLERS): `reviewedAt/By` set, so it
 * leaves the review list. The caller writes the platform audit `partner.attribution.review`.
 */
export async function reviewAttribution(attributionId: string, staff: Staff, now: Date = new Date()): Promise<{ tenantId: string; tenantSlug: string; partnerSlug: string | null }> {
  const id = cleanId(attributionId);
  const row = id
    ? await controlDb().tenantAttribution.findUnique({
        where: { id },
        select: { id: true, tenantId: true, validTo: true, flags: true, reviewedAt: true, partner: { select: { slug: true } }, tenant: { select: { slug: true } } },
      })
    : null;
  if (!row) throw new PartnerRefused("That no longer exists.");
  if (row.validTo) throw new PartnerRefused("That attribution is no longer the current one.");
  if (row.flags === null) throw new PartnerRefused("Nothing on it is flagged.");
  if (row.reviewedAt) throw new PartnerRefused("It has been reviewed already.");
  const done = await controlDb().tenantAttribution.updateMany({ where: { id: row.id, validTo: null, reviewedAt: null }, data: { reviewedAt: now, reviewedBy: `staff:${staff.id}` } });
  if (done.count === 0) throw new PartnerRefused("It has been reviewed already.");
  return { tenantId: row.tenantId, tenantSlug: row.tenant.slug, partnerSlug: row.partner?.slug ?? null };
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** The row in force at `at` — `validFrom ≤ at` and (`validTo` null or later) — or null: the workspace had none then. */
export async function attributionAt(
  tenantId: string,
  at: Date,
): Promise<{ id: string; partnerId: string | null; source: AttributionSource; commissionable: boolean; validFrom: Date } | null> {
  const row = await controlDb().tenantAttribution.findFirst({
    where: { tenantId: cleanId(tenantId), validFrom: { lte: at }, OR: [{ validTo: null }, { validTo: { gt: at } }] },
    orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
    select: { id: true, partnerId: true, source: true, commissionable: true, validFrom: true },
  });
  return row ?? null;
}

/** One row of a workspace's attribution history, for staff (reason, flags and who made it included). */
export type AttributionHistoryRow = {
  id: string;
  partner: { id: string; slug: string; displayName: string } | null;
  source: AttributionSource;
  reference: string | null;
  reason: string | null;
  commissionable: boolean;
  flags: AttributionFlags | null;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  validFrom: Date;
  validTo: Date | null;
  /** "signup", "staff:<id>" or "script" — refLabels() in audit.ts names them. */
  createdBy: string;
};

/** A workspace's attributions, the latest first (the current one, when there is one, leads). */
export async function attributionHistory(tenantId: string, take = 20): Promise<AttributionHistoryRow[]> {
  const rows = await controlDb().tenantAttribution.findMany({
    where: { tenantId: cleanId(tenantId) },
    orderBy: [{ validFrom: "desc" }, { createdAt: "desc" }],
    take: Math.max(1, Math.min(200, Math.floor(Number(take) || 20))),
    select: {
      id: true,
      partner: { select: { id: true, slug: true, displayName: true } },
      source: true,
      reference: true,
      reason: true,
      commissionable: true,
      flags: true,
      reviewedAt: true,
      reviewedBy: true,
      validFrom: true,
      validTo: true,
      createdBy: true,
    },
  });
  return rows.map((r) => ({ ...r, flags: (r.flags as unknown as AttributionFlags | null) ?? null }));
}
