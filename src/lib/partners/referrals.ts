import { createHash, randomBytes, randomInt } from "node:crypto";
import { Prisma, type DealStatus } from "@deskzo/control-client";
import { isDisposableDomain, parseEmailAddress } from "@/lib/email-verification";
import { partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { cleanCountry, cleanId, mailPartnerUsers, manyLines, meActor, oneLine, optionalText, requiredText, staffActor } from "@/lib/partners/registry";
import { dealDays } from "@/lib/partners/settings";
import { PARTNER_LIMITS, PARTNER_SELLERS, PartnerRefused, type PartnerMe } from "@/lib/partners/types";
import { consoleClock } from "@/lib/platform/console-clock";
import { controlDb } from "@/lib/platform/control-db";
import { siteOrigin } from "@/lib/platform/site-content";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * How partners bring customers in (spec §4.2, §4.3):
 *
 *   · Invitation codes — `signup_invites` rows with `partnerId`, made the way the console makes its
 *     own (nine random bytes, only the SHA-256 kept, shown once), plus the last four characters as a
 *     `codeHint` so a partner can tell its codes apart. 50 a day per partner.
 *   · Referral links — public codes (`<partner>-<five letters or digits>`) in `/signup?ref=<code>`.
 *     They credit the partner and may name a starting plan; they never open signup while it is by
 *     invitation. At most 50 live per partner.
 *   · Deal registrations — a claim on a prospect company by its email domain, exclusive while
 *     PENDING or APPROVED. A refusal never says who holds it. 20 a day and 200 open per partner.
 *
 * Every limit is a count in the database — rows made by the partner in the last 24 hours, or its
 * open rows — so it holds across processes. Creating needs the partner ACTIVE and a selling role
 * (ADMIN, SALES); ending, withdrawing and deciding do not.
 */

const DAY = 86_400_000;
const NOT_ACTIVE = "Your partner account is not active, so it cannot create codes, links or registrations.";
const GONE = "That no longer exists.";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The caller's partner, read fresh, when it may sell now: a selling role, and ACTIVE. */
async function sellingPartner(me: PartnerMe) {
  if (!PARTNER_SELLERS.includes(me.role)) throw new PartnerRefused("Your role cannot do that.");
  const partner = await controlDb().partner.findUnique({ where: { id: me.partner.id }, select: { id: true, slug: true, status: true, territories: true } });
  if (!partner || partner.status === "TERMINATED") throw new PartnerRefused("Sign in to the partner portal again.");
  if (partner.status !== "ACTIVE") throw new PartnerRefused(NOT_ACTIVE);
  return partner;
}

function sellerRole(me: PartnerMe): void {
  if (!PARTNER_SELLERS.includes(me.role)) throw new PartnerRefused("Your role cannot do that.");
}

/** A plan a new workspace may start on — active and sold — or a refusal (the console's words). */
async function offeredPlan(raw: unknown): Promise<{ key: string; name: string } | null> {
  const key = oneLine(raw).slice(0, 64);
  if (!key) return null;
  const plan = await controlDb().plan.findUnique({ where: { key }, select: { key: true, name: true, active: true, kind: true } });
  if (!plan || !plan.active || plan.kind === "INTERNAL") throw new PartnerRefused("That plan is not one a new workspace can start on.");
  return { key: plan.key, name: plan.name };
}

const wholeIn = (raw: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Math.round(Number(raw) || fallback)));

// ─── Invitation codes ────────────────────────────────────────────────────────────────────────────

export type PartnerInviteInput = { note?: string | null; uses?: number; days?: number; planKey?: string | null };

/**
 * A new invitation code for the caller's partner. The code is returned here once and never again;
 * the code's hash is its handle from now on (`codeHash`), and its last four characters its hint.
 */
export async function createPartnerInvite(me: PartnerMe, input: PartnerInviteInput, now: Date = new Date()): Promise<{ code: string; codeHint: string; codeHash: string }> {
  const partner = await sellingPartner(me);
  const days = wholeIn(input?.days, 1, 90, 14);
  const uses = wholeIn(input?.uses, 1, 100, 1);
  const note = optionalText(input?.note, 200, "Keep the note to 200 characters.");
  const plan = await offeredPlan(input?.planKey);
  const today = await controlDb().signupInvite.count({ where: { partnerId: partner.id, createdAt: { gt: new Date(now.getTime() - DAY) } } });
  if (today >= PARTNER_LIMITS.invitesPerDay) throw new PartnerRefused(`Your company has made ${PARTNER_LIMITS.invitesPerDay} invitation codes in the last 24 hours. Try again tomorrow.`);
  const code = randomBytes(9).toString("base64url");
  const codeHash = sha256(code);
  const codeHint = code.slice(-4);
  await controlDb().$transaction(async (tx) => {
    await tx.signupInvite.create({
      data: { codeHash, note, maxUses: uses, expiresAt: new Date(now.getTime() + days * DAY), createdBy: `partner:${me.id}`, planKey: plan?.key ?? null, partnerId: partner.id, codeHint },
      select: { codeHash: true },
    });
    // Named by its hash's first eight characters, as the console's own invitations are.
    await partnerAudit(meActor(me), partner.id, "invite.create", "invite", codeHash.slice(0, 8), { uses, days, planKey: plan?.key ?? null }, { tx });
  });
  return { code, codeHint, codeHash };
}

/**
 * Ends one of the caller's partner's live codes now (`expiresAt = now` — which is how a list tells
 * an ended code from an expired one: an `invite.end` row names it). Another partner's code, or none,
 * is "That no longer exists.".
 */
export async function endPartnerInvite(me: PartnerMe, codeHash: string, now: Date = new Date()): Promise<void> {
  sellerRole(me);
  const hash = String(codeHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new PartnerRefused(GONE);
  const invite = await controlDb().signupInvite.findFirst({ where: { codeHash: hash, partnerId: me.partner.id }, select: { uses: true, maxUses: true } });
  if (!invite) throw new PartnerRefused(GONE);
  if (invite.uses >= invite.maxUses) throw new PartnerRefused("It is used up already — its code no longer works.");
  await controlDb().$transaction(async (tx) => {
    const ended = await tx.signupInvite.updateMany({ where: { codeHash: hash, partnerId: me.partner.id, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, data: { expiresAt: now } });
    if (ended.count === 0) throw new PartnerRefused("It has ended already.");
    await partnerAudit(meActor(me), me.partner.id, "invite.end", "invite", hash.slice(0, 8), undefined, { tx });
  });
}

/**
 * For signup: why a partner's invitation code may not be used now — its partner is not ACTIVE — or
 * null (not a partner's code, or its partner is active). Signup shows its own wording; this reason
 * is never shown. The code's own uses and expiry are signup's to check.
 */
export async function partnerInviteProblem(codeHash: string, now: Date = new Date()): Promise<string | null> {
  void now; // The partner's status is what it is now; the parameter keeps the signup call explicit about time.
  const hash = String(codeHash ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const invite = await controlDb().signupInvite.findUnique({ where: { codeHash: hash }, select: { partnerId: true, partner: { select: { status: true } } } });
  if (!invite?.partnerId) return null;
  return invite.partner?.status === "ACTIVE" ? null : "The partner behind this invitation is not active.";
}

// ─── Referral links ──────────────────────────────────────────────────────────────────────────────

const CODE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A referral code as typed or followed: lower-case, 6–40, letters and digits in hyphen-separated groups; null for anything else. */
export function cleanReferralCode(raw: unknown): string | null {
  const code = String(raw ?? "").trim().toLowerCase();
  return code.length >= 6 && code.length <= 40 && CODE.test(code) ? code : null;
}

function newCode(slug: string): string {
  // The partner's address, shortened so the whole code stays within 40 characters, then five random characters.
  const stem = slug.replace(/-+/g, "-").slice(0, 34).replace(/-+$/, "");
  let tail = "";
  for (let i = 0; i < 5; i++) tail += CODE_CHARS[randomInt(0, CODE_CHARS.length)];
  return `${stem}-${tail}`;
}

export type ReferralLinkInput = { label?: string | null; planKey?: string | null; days?: number | null };

/** A referral link just made — what the portal turns into its LinkRow (no signups yet). */
export type ReferralLinkMade = { id: string; code: string; url: string; label: string | null; planKey: string | null; planName: string | null; expiresAt: Date | null; createdAt: Date };

export const referralUrl = (code: string) => `${siteOrigin()}/signup?ref=${encodeURIComponent(code)}`;

/** A new referral link for the caller's partner — at most 50 live; `days` (1–365) or none for no end. */
export async function createReferralLink(me: PartnerMe, input: ReferralLinkInput, now: Date = new Date()): Promise<ReferralLinkMade> {
  const partner = await sellingPartner(me);
  const label = optionalText(input?.label, 80, "Keep the label to 80 characters.");
  const plan = await offeredPlan(input?.planKey);
  const days = input?.days === null || input?.days === undefined || String(input.days).trim() === "" ? null : wholeIn(input.days, 1, 365, 30);
  const live = await controlDb().partnerReferralLink.count({ where: { partnerId: partner.id, endedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } });
  if (live >= PARTNER_LIMITS.liveLinks) throw new PartnerRefused(`Your company has ${PARTNER_LIMITS.liveLinks} live referral links. End one first.`);
  for (let attempt = 0; ; attempt++) {
    const code = newCode(partner.slug);
    try {
      const made = await controlDb().$transaction(async (tx) => {
        const row = await tx.partnerReferralLink.create({
          data: { code, partnerId: partner.id, label, planKey: plan?.key ?? null, expiresAt: days ? new Date(now.getTime() + days * DAY) : null, createdBy: `partner:${me.id}` },
          select: { id: true, code: true, label: true, planKey: true, expiresAt: true, createdAt: true },
        });
        await partnerAudit(meActor(me), partner.id, "link.create", "link", row.id, { code: row.code, planKey: row.planKey }, { tx });
        return row;
      });
      return { ...made, url: referralUrl(made.code), planName: plan?.name ?? null };
    } catch (err) {
      const taken = (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";
      // Five random characters rarely meet an existing code; another draw does.
      if (!taken || attempt >= 5) throw err;
    }
  }
}

/** Ends one of the caller's partner's links now. Another partner's, or none, is "That no longer exists.". */
export async function endReferralLink(me: PartnerMe, linkId: string, now: Date = new Date()): Promise<void> {
  sellerRole(me);
  const id = cleanId(linkId);
  const link = id ? await controlDb().partnerReferralLink.findFirst({ where: { id, partnerId: me.partner.id }, select: { id: true, code: true, endedAt: true } }) : null;
  if (!link) throw new PartnerRefused(GONE);
  if (link.endedAt) throw new PartnerRefused("It has ended already.");
  await controlDb().$transaction(async (tx) => {
    const ended = await tx.partnerReferralLink.updateMany({ where: { id: link.id, partnerId: me.partner.id, endedAt: null }, data: { endedAt: now } });
    if (ended.count === 0) throw new PartnerRefused("It has ended already.");
    await partnerAudit(meActor(me), me.partner.id, "link.end", "link", link.id, { code: link.code }, { tx });
  });
}

/** A live referral code and whose it is. `planKey` only when that plan is still offered (and, given `country`, sold there). */
export type ActiveReferral = { linkId: string; code: string; partnerId: string; partnerName: string; planKey: string | null };

/**
 * The referral link behind a code, while it may credit anybody: not ended, not expired, its partner
 * ACTIVE. Null for anything else — an unknown, ended or malformed code, or a partner that is not
 * active — so a forged or stale code attributes nothing.
 */
export async function findActiveReferral(code: string, now: Date = new Date(), country?: string | null): Promise<ActiveReferral | null> {
  const key = cleanReferralCode(code);
  if (!key) return null;
  const link = await controlDb().partnerReferralLink.findUnique({
    where: { code: key },
    select: { id: true, code: true, endedAt: true, expiresAt: true, planKey: true, partner: { select: { id: true, displayName: true, status: true } } },
  });
  if (!link || link.endedAt || (link.expiresAt && link.expiresAt <= now) || link.partner.status !== "ACTIVE") return null;
  let planKey: string | null = null;
  if (link.planKey) {
    // A plan retired since the link was made falls back to the default plan rather than failing the signup.
    const plan = await controlDb().plan.findUnique({ where: { key: link.planKey }, select: { key: true, active: true, kind: true, countries: true } });
    const where = String(country ?? "").trim().toUpperCase();
    if (plan && plan.active && plan.kind !== "INTERNAL" && (!where || !plan.countries.length || plan.countries.includes(where))) planKey = plan.key;
  }
  return { linkId: link.id, code: link.code, partnerId: link.partner.id, partnerName: link.partner.displayName, planKey };
}

// ─── Deal registrations ──────────────────────────────────────────────────────────────────────────

/** Mail providers anybody can have an address at: a company is never registered by one of these. */
export const FREE_MAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.in",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "zoho.com",
  "zohomail.in",
  "rediffmail.com",
  "gmx.com",
  "yandex.com",
  "mail.com",
];
const FREE_MAIL = new Set(FREE_MAIL_DOMAINS);

/** An address's domain, lower-case, or null when it is not an address. */
export function emailDomain(email: string): string | null {
  return parseEmailAddress(String(email ?? ""))?.domain ?? null;
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** "https://www.Acme.example/about" → "acme.example"; an address gives its domain; null for anything that is not a domain. */
export function cleanDomain(raw: unknown): string | null {
  let text = String(raw ?? "").trim().toLowerCase();
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  text = text.replace(/[/?#].*$/, "");
  if (text.includes("@")) text = text.slice(text.lastIndexOf("@") + 1);
  text = text.replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  return text.length <= 253 && DOMAIN.test(text) ? text : null;
}

export type DealInput = {
  companyName: string;
  domain: string;
  country: string;
  contactName?: string | null;
  contactEmail?: string | null;
  expectedPlanKey?: string | null;
  note?: string | null;
};

/** A registration just made — the portal's DealRow shape. */
export type RegisteredDeal = {
  id: string;
  companyName: string;
  domain: string;
  country: string;
  status: DealStatus;
  expiresAt: Date | null;
  decisionNote: string | null;
  customer: { slug: string; name: string } | null;
  createdAt: Date;
};

const TAKEN = "That company is already a customer or registered.";
const EXPIRY_ACTOR: PartnerActor = { kind: "system", name: "deal-expiry" };

/** Approved registrations past their protection become EXPIRED — all of them (the tick), or one domain's (just before it is registered again). */
async function expireWhere(where: Prisma.DealRegistrationWhereInput, now: Date): Promise<number> {
  const due = await controlDb().dealRegistration.findMany({ where: { ...where, status: "APPROVED", expiresAt: { lte: now } }, take: 2000, select: { id: true, partnerId: true, companyName: true, domain: true } });
  if (!due.length) return 0;
  const expired = await controlDb().dealRegistration.updateMany({ where: { id: { in: due.map((d) => d.id) }, status: "APPROVED", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
  for (const d of due) await partnerAudit(EXPIRY_ACTOR, d.partnerId, "deal.expire", "deal", d.id, { companyName: d.companyName, domain: d.domain });
  return expired.count;
}

/** The daily tick: every approved registration whose protection has run out becomes EXPIRED. Returns how many. */
export async function expireDeals(now: Date = new Date()): Promise<number> {
  return expireWhere({}, now);
}

/** The approved, unexpired registration of a domain whose partner is ACTIVE — the signup precedence's first claim. */
export async function activeDealFor(domain: string, now: Date = new Date()): Promise<{ id: string; partnerId: string } | null> {
  const key = cleanDomain(domain);
  if (!key) return null;
  const deal = await controlDb().dealRegistration.findFirst({
    where: { domain: key, status: "APPROVED", expiresAt: { gt: now }, partner: { status: "ACTIVE" } },
    orderBy: { createdAt: "asc" },
    select: { id: true, partnerId: true },
  });
  return deal ?? null;
}

/**
 * A partner's claim on a company (portal: ADMIN, SALES while ACTIVE; spec §4.3). Refused — with one
 * message that names nobody — when a workspace's owner or billing address is on the domain, or an
 * open registration holds it.
 */
export async function registerDeal(me: PartnerMe, input: DealInput, now: Date = new Date()): Promise<RegisteredDeal> {
  const partner = await sellingPartner(me);
  const x = (input ?? {}) as DealInput;
  const companyName = requiredText(x.companyName, 2, 160, "Give the company's name (2 to 160 characters).");
  const domain = cleanDomain(x.domain);
  if (!domain) throw new PartnerRefused("Give the company's email domain, like acme.example.");
  if (FREE_MAIL.has(domain) || isDisposableDomain(domain)) throw new PartnerRefused("That is a public mail provider, not a company's domain.");
  const country = cleanCountry(x.country);
  if (!partner.territories.includes(country)) throw new PartnerRefused("Outside your territories.");
  const contactName = optionalText(x.contactName, 120, "Keep the contact's name to 120 characters.");
  let contactEmail: string | null = null;
  if (oneLine(x.contactEmail)) {
    const parsed = parseEmailAddress(String(x.contactEmail));
    if (!parsed) throw new PartnerRefused("The contact's email doesn't look like an email address.");
    if (parsed.domain !== domain && !parsed.domain.endsWith(`.${domain}`)) throw new PartnerRefused(`The contact's email must be on ${domain}.`);
    contactEmail = `${parsed.local}@${parsed.domain}`;
  }
  const expectedPlanKey = (await offeredPlan(x.expectedPlanKey))?.key ?? null;
  const note = manyLines(x.note) || null;
  if (note && note.length > 1000) throw new PartnerRefused("Keep the note to 1,000 characters.");

  const control = controlDb();
  const [today, open] = await Promise.all([
    control.dealRegistration.count({ where: { partnerId: partner.id, createdAt: { gt: new Date(now.getTime() - DAY) } } }),
    control.dealRegistration.count({ where: { partnerId: partner.id, status: { in: ["PENDING", "APPROVED"] } } }),
  ]);
  if (today >= PARTNER_LIMITS.dealsPerDay) throw new PartnerRefused(`Your company has registered ${PARTNER_LIMITS.dealsPerDay} companies in the last 24 hours. Try again tomorrow.`);
  if (open >= PARTNER_LIMITS.openDeals) throw new PartnerRefused(`Your company has ${PARTNER_LIMITS.openDeals} open registrations. Withdraw some first.`);

  await expireWhere({ domain }, now);
  const [customer, held] = await Promise.all([
    control.tenant.count({
      where: { status: { not: "DEPROVISIONED" }, OR: [{ ownerEmail: { endsWith: `@${domain}`, mode: "insensitive" } }, { billingEmail: { endsWith: `@${domain}`, mode: "insensitive" } }] },
    }),
    control.dealRegistration.count({ where: { domain, status: { in: ["PENDING", "APPROVED"] } } }),
  ]);
  if (customer || held) throw new PartnerRefused(TAKEN);

  try {
    return await control.$transaction(async (tx) => {
      const deal = await tx.dealRegistration.create({
        data: { partnerId: partner.id, companyName, domain, country, contactName, contactEmail, expectedPlanKey, note, submittedBy: me.id },
        select: { id: true, companyName: true, domain: true, country: true, status: true, expiresAt: true, decisionNote: true, createdAt: true },
      });
      await partnerAudit(meActor(me), partner.id, "deal.register", "deal", deal.id, { companyName, domain }, { tx });
      return { ...deal, customer: null };
    });
  } catch (err) {
    // Two partners registering one domain at once: the second meets the index, and hears the same.
    if ((err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002") {
      throw new PartnerRefused(TAKEN);
    }
    throw err;
  }
}

/** The caller's partner withdraws one of its PENDING or APPROVED registrations. Another partner's, or none, is "That no longer exists.". */
export async function withdrawDeal(me: PartnerMe, dealId: string, now: Date = new Date()): Promise<void> {
  sellerRole(me);
  const id = cleanId(dealId);
  const deal = id ? await controlDb().dealRegistration.findFirst({ where: { id, partnerId: me.partner.id }, select: { id: true, status: true, expiresAt: true, companyName: true, domain: true } }) : null;
  if (!deal) throw new PartnerRefused(GONE);
  if (deal.status === "APPROVED" && deal.expiresAt && deal.expiresAt <= now) throw new PartnerRefused("Its protection has ended already.");
  if (deal.status !== "PENDING" && deal.status !== "APPROVED") throw new PartnerRefused("Only a pending or approved registration can be withdrawn.");
  await controlDb().$transaction(async (tx) => {
    const done = await tx.dealRegistration.updateMany({ where: { id: deal.id, partnerId: me.partner.id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "WITHDRAWN" } });
    if (done.count === 0) throw new PartnerRefused("Only a pending or approved registration can be withdrawn.");
    await partnerAudit(meActor(me), me.partner.id, "deal.withdraw", "deal", deal.id, { companyName: deal.companyName, domain: deal.domain }, { tx });
  });
}

/**
 * Staff's decision on a PENDING registration (console, SELLERS): approved, it is protected for
 * `partners.dealDays` days from now; declined, it is closed. The optional note is shown to the
 * partner. The submitting user is emailed. Returns what the console action's platform audit names.
 */
export async function decideDeal(
  dealId: string,
  decisionInput: "APPROVE" | "DECLINE",
  noteInput: string | null | undefined,
  staff: Staff,
  now: Date = new Date(),
): Promise<{ partnerId: string; partnerSlug: string; companyName: string; domain: string; status: DealStatus; expiresAt: Date | null }> {
  const decision = String(decisionInput ?? "").toUpperCase();
  if (decision !== "APPROVE" && decision !== "DECLINE") throw new PartnerRefused("Approve or decline it.");
  const note = optionalText(noteInput, 500, "Keep the note to 500 characters.");
  const id = cleanId(dealId);
  const deal = id
    ? await controlDb().dealRegistration.findUnique({ where: { id }, select: { id: true, status: true, partnerId: true, companyName: true, domain: true, submittedBy: true, partner: { select: { slug: true } } } })
    : null;
  if (!deal) throw new PartnerRefused(GONE);
  if (deal.status !== "PENDING") throw new PartnerRefused("That registration has been decided already.");
  const status: DealStatus = decision === "APPROVE" ? "APPROVED" : "DECLINED";
  const expiresAt = status === "APPROVED" ? new Date(now.getTime() + (await dealDays()) * DAY) : null;
  await controlDb().$transaction(async (tx) => {
    const done = await tx.dealRegistration.updateMany({
      where: { id: deal.id, status: "PENDING" },
      data: { status, expiresAt, decidedBy: `staff:${staff.id}`, decidedAt: now, decisionNote: note },
    });
    if (done.count === 0) throw new PartnerRefused("That registration has been decided already.");
    await partnerAudit(staffActor(staff), deal.partnerId, status === "APPROVED" ? "deal.approve" : "deal.decline", "deal", deal.id, { companyName: deal.companyName, domain: deal.domain }, { tx });
  });
  // The day it ends on the portal's clock — the console's (Settings › Time zone) — as the partner's deal list shows it.
  const lines =
    status === "APPROVED"
      ? [`Your registration of ${deal.companyName} (${deal.domain}) has been approved. It is protected until ${(await consoleClock()).date(expiresAt!)}: a workspace that signs up from ${deal.domain} before then is credited to you.`]
      : [`Your registration of ${deal.companyName} (${deal.domain}) has been declined.`];
  if (note) lines.push("", `Note from your partner manager: ${note}`);
  await mailPartnerUsers(deal.partnerId, { userIds: [deal.submittedBy] }, `Partner portal: deal registration ${status === "APPROVED" ? "approved" : "declined"}`, lines);
  return { partnerId: deal.partnerId, partnerSlug: deal.partner.slug, companyName: deal.companyName, domain: deal.domain, status, expiresAt };
}
