import { Prisma, type PartnerApplicationStatus, type PartnerKind, type PartnerRequestKind, type PartnerRequestStatus, type PartnerRole } from "@wroffy/control-client";
import { isDisposableDomain, parseEmailAddress } from "@/lib/email-verification";
import { actorRef, partnerAudit } from "@/lib/partners/audit";
import { cleanPayout, mailPayoutChanged, maskOf, payoutFromJson, writePayout } from "@/lib/partners/payout";
import {
  cleanAddress,
  cleanContactName,
  cleanCountry,
  cleanDisplayName,
  cleanEmail,
  cleanId,
  cleanLegalName,
  cleanPartnerInput,
  cleanPhone,
  cleanTaxIds,
  cleanTerritories,
  cleanWebsite,
  createPartnerWith,
  mailPartnerUsers,
  manyLines,
  meActor,
  requiredText,
  staffActor,
} from "@/lib/partners/registry";
import { cleanTerms } from "@/lib/partners/terms";
import { PARTNER_LIMITS, PartnerRefused, type PartnerInput, type PartnerMe, type PayoutInput, type TermsInput } from "@/lib/partners/types";
import { createPartnerUser } from "@/lib/partners/users";
import { controlDb } from "@/lib/platform/control-db";
import { openForPartner, sealForPartner } from "@/lib/platform/kek";
import type { Staff } from "@/lib/platform/staff-session";

/**
 * What partners ask staff to decide (partner_requests), and applications to join (partner_applications).
 *
 *   · PROFILE — legal name, country, contact, address, tax ids (ADMIN). Approved, the fields apply.
 *   · PAYOUT — new bank details (ADMIN, FINANCE): sealed on arrival ("partner-payout-request"), the
 *     request's payload holding only the new mask. Approved by OWNER or BILLING staff, they become
 *     the partner's payout details. The sealed copy is cleared on any decision, and on withdrawal.
 *   · NEW_RESELLER — a distributor proposes a reseller inside its territories (ADMIN, ten pending at
 *     most). Approved, staff give its address and terms; it is made under the distributor, and its
 *     proposed contact is invited as its first ADMIN.
 *
 * One PROFILE and one PAYOUT may wait per partner (a partial unique index). The requester is emailed
 * the decision. Applications come from the public "Become a partner" form; staff review them and may
 * turn one into a partner.
 */

const GONE = "That no longer exists.";
const WAITING = "A change is already waiting for review — withdraw it first.";

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

/** Which kinds of request each role may make (and withdraw). */
const KINDS_BY_ROLE: Record<PartnerRole, PartnerRequestKind[]> = { ADMIN: ["PROFILE", "PAYOUT", "NEW_RESELLER"], FINANCE: ["PAYOUT"], SALES: [], VIEWER: [] };

/** The caller's partner, read fresh; a terminated one reads as signed out. */
async function ownPartner(me: PartnerMe) {
  const partner = await controlDb().partner.findUnique({
    where: { id: me.partner.id },
    select: { id: true, slug: true, kind: true, status: true, territories: true, legalName: true, country: true, contactName: true, contactEmail: true, addressLine1: true, addressLine2: true, city: true, region: true, postalCode: true, taxIds: true },
  });
  if (!partner || partner.status === "TERMINATED") throw new PartnerRefused("Sign in to the partner portal again.");
  return partner;
}

function mayRequest(me: PartnerMe, kind: PartnerRequestKind): void {
  if (!KINDS_BY_ROLE[me.role]?.includes(kind)) throw new PartnerRefused("Your role cannot do that.");
}

async function createRequest(me: PartnerMe, kind: PartnerRequestKind, payload: Record<string, unknown>, cipher: string | null, detail: Record<string, unknown>): Promise<{ id: string }> {
  try {
    return await controlDb().$transaction(async (tx) => {
      if ((kind === "PROFILE" || kind === "PAYOUT") && (await tx.partnerRequest.count({ where: { partnerId: me.partner.id, kind, status: "PENDING" } }))) throw new PartnerRefused(WAITING);
      const made = await tx.partnerRequest.create({
        data: { partnerId: me.partner.id, kind, payload: payload as Prisma.InputJsonValue, payloadCipher: cipher, requestedBy: `partner:${me.id}` },
        select: { id: true },
      });
      await partnerAudit(meActor(me), me.partner.id, "request.create", "request", made.id, { kind, ...detail }, { tx });
      return made;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PartnerRefused(WAITING);
    throw err;
  }
}

// ─── Asking ──────────────────────────────────────────────────────────────────────────────────────

export type ProfileChangeInput = {
  legalName?: string;
  country?: string;
  contactName?: string;
  contactEmail?: string;
  address?: PartnerInput["address"];
  taxIds?: { kind: string; value: string }[];
};

/** The fields a PROFILE request carries, as the columns they will be written to. */
type ProfileFields = Partial<{
  legalName: string;
  country: string;
  contactName: string;
  contactEmail: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  taxIds: { kind: string; value: string }[];
}>;

/** A PROFILE request's fields checked — for asking and again for applying. */
function cleanProfileFields(x: ProfileChangeInput | ProfileFields): ProfileFields {
  const out: ProfileFields = {};
  const v = (x ?? {}) as Record<string, unknown>;
  if (v.legalName !== undefined) out.legalName = cleanLegalName(v.legalName);
  if (v.country !== undefined) out.country = cleanCountry(v.country, "Choose the country the company is established in.");
  if (v.contactName !== undefined) out.contactName = cleanContactName(v.contactName);
  if (v.contactEmail !== undefined) out.contactEmail = cleanEmail(v.contactEmail, "The contact's email doesn't look like an email address.");
  // The portal sends an address object; a stored request holds the columns.
  const address = (v.address && typeof v.address === "object" ? v.address : {}) as Record<string, unknown>;
  const given = {
    addressLine1: v.addressLine1 !== undefined ? v.addressLine1 : address.line1,
    addressLine2: v.addressLine2 !== undefined ? v.addressLine2 : address.line2,
    city: v.city !== undefined ? v.city : address.city,
    region: v.region !== undefined ? v.region : address.region,
    postalCode: v.postalCode !== undefined ? v.postalCode : address.postalCode,
  };
  const lines = cleanAddress({ line1: given.addressLine1 as string, line2: given.addressLine2 as string, city: given.city as string, region: given.region as string, postalCode: given.postalCode as string });
  for (const key of Object.keys(given) as (keyof typeof given)[]) if (given[key] !== undefined) out[key] = lines[key];
  if (v.taxIds !== undefined) out.taxIds = cleanTaxIds(v.taxIds);
  return out;
}

/**
 * A partner's ADMIN asks for a change to its legal and contact details or tax ids. Only the fields
 * that differ from what is on file are kept; none is "Nothing to change.".
 */
export async function requestProfileChange(me: PartnerMe, input: ProfileChangeInput): Promise<{ id: string }> {
  mayRequest(me, "PROFILE");
  const partner = await ownPartner(me);
  const asked = cleanProfileFields(input ?? {});
  const current = partner as unknown as Record<string, unknown>;
  const fields = Object.fromEntries(Object.entries(asked).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(current[k] ?? null)));
  if (!Object.keys(fields).length) throw new PartnerRefused("Nothing to change.");
  return createRequest(me, "PROFILE", fields, null, { fields: Object.keys(fields) });
}

/**
 * A partner's ADMIN or FINANCE user submits new bank details: sealed at once, bound to the partner;
 * the request shows staff (and the portal) the new mask only.
 */
export async function requestPayoutChange(me: PartnerMe, input: PayoutInput): Promise<{ id: string }> {
  mayRequest(me, "PAYOUT");
  const partner = await ownPartner(me);
  const details = cleanPayout(input);
  const cipher = sealForPartner(partner.id, "partner-payout-request", JSON.stringify(details));
  return createRequest(me, "PAYOUT", maskOf(details), cipher, {});
}

export type ResellerProposal = { legalName: string; displayName: string; country: string; territories: string[]; contactName: string; contactEmail: string; note?: string | null };

/** A distributor's ADMIN proposes a reseller inside its own territories — at most ten waiting at once. */
export async function requestReseller(me: PartnerMe, input: ResellerProposal): Promise<{ id: string }> {
  mayRequest(me, "NEW_RESELLER");
  const partner = await ownPartner(me);
  if (partner.kind !== "DISTRIBUTOR") throw new PartnerRefused("Only a distributor can propose resellers.");
  const x = (input ?? {}) as ResellerProposal;
  const territories = cleanTerritories(x.territories);
  const outside = territories.filter((c) => !partner.territories.includes(c));
  if (outside.length) throw new PartnerRefused(`Outside your territories: ${outside.join(", ")}.`);
  const note = manyLines(x.note) || null;
  if (note && note.length > 1000) throw new PartnerRefused("Keep the note to 1,000 characters.");
  const payload = {
    legalName: cleanLegalName(x.legalName),
    displayName: cleanDisplayName(x.displayName),
    country: cleanCountry(x.country, "Choose the country the company is established in."),
    territories,
    contactName: cleanContactName(x.contactName),
    contactEmail: cleanEmail(x.contactEmail, "The contact's email doesn't look like an email address."),
    note,
  };
  const pending = await controlDb().partnerRequest.count({ where: { partnerId: partner.id, kind: "NEW_RESELLER", status: "PENDING" } });
  if (pending >= PARTNER_LIMITS.pendingResellers) throw new PartnerRefused(`${PARTNER_LIMITS.pendingResellers} proposed resellers are already waiting for review.`);
  return createRequest(me, "NEW_RESELLER", payload, null, { displayName: payload.displayName });
}

/** The caller withdraws one of its partner's PENDING requests, of a kind its role may make. The sealed details go with it. */
export async function withdrawRequest(me: PartnerMe, requestId: string, now: Date = new Date()): Promise<void> {
  const id = cleanId(requestId);
  const request = id ? await controlDb().partnerRequest.findFirst({ where: { id, partnerId: me.partner.id }, select: { id: true, kind: true, status: true } }) : null;
  if (!request) throw new PartnerRefused(GONE);
  mayRequest(me, request.kind);
  if (request.status !== "PENDING") throw new PartnerRefused("That request has been decided already.");
  await controlDb().$transaction(async (tx) => {
    const done = await tx.partnerRequest.updateMany({
      where: { id: request.id, partnerId: me.partner.id, status: "PENDING" },
      data: { status: "WITHDRAWN", payloadCipher: null, decidedAt: now, decidedBy: `partner:${me.id}` },
    });
    if (done.count === 0) throw new PartnerRefused("That request has been decided already.");
    await partnerAudit(meActor(me), me.partner.id, "request.withdraw", "request", request.id, { kind: request.kind }, { tx });
  });
}

// ─── Deciding ────────────────────────────────────────────────────────────────────────────────────

/** What a decision did — for the console action's platform audit and its answer. */
export type RequestDecided = {
  partnerId: string;
  partnerSlug: string;
  kind: PartnerRequestKind;
  status: Extract<PartnerRequestStatus, "APPROVED" | "REJECTED">;
  /** NEW_RESELLER approved: the reseller made. */
  resultPartner: { id: string; slug: string } | null;
  /** NEW_RESELLER approved: its proposed contact invited as ADMIN — the one-time setup URL — or why not. */
  invite: { setupUrl: string; emailed: boolean } | { error: string } | null;
};

const KIND_WORDS: Record<PartnerRequestKind, string> = { PROFILE: "change to your company profile", PAYOUT: "new payout details", NEW_RESELLER: "proposed reseller" };

/**
 * Staff's decision on a PENDING request (console: PROFILE and NEW_RESELLER by MANAGERS, PAYOUT by
 * PAYERS — the action checks the role after reading the kind). The decision and its effect happen in
 * one transaction; the request's sealed copy is cleared either way; the requester is emailed.
 */
export async function decideRequest(
  requestId: string,
  decisionInput: "APPROVE" | "REJECT",
  noteInput: string | null | undefined,
  staff: Staff,
  reseller?: { slug: string; terms: TermsInput } | null,
  now: Date = new Date(),
): Promise<RequestDecided> {
  const decision = String(decisionInput ?? "").toUpperCase();
  if (decision !== "APPROVE" && decision !== "REJECT") throw new PartnerRefused("Approve or reject it.");
  const note = manyLines(noteInput) || null;
  if (note && note.length > 500) throw new PartnerRefused("Keep the note to 500 characters.");
  const id = cleanId(requestId);
  const request = id
    ? await controlDb().partnerRequest.findUnique({
        where: { id },
        select: { id: true, kind: true, status: true, payload: true, payloadCipher: true, requestedBy: true, partnerId: true, partner: { select: { slug: true, status: true } } },
      })
    : null;
  if (!request) throw new PartnerRefused(GONE);
  if (request.status !== "PENDING") throw new PartnerRefused("That request has been decided already.");
  const actor = staffActor(staff);
  const status = decision === "APPROVE" ? ("APPROVED" as const) : ("REJECTED" as const);

  /** Marks it decided, conditionally, inside the transaction that does its effect. */
  const claim = async (tx: Prisma.TransactionClient, resultPartnerId: string | null = null) => {
    const done = await tx.partnerRequest.updateMany({
      where: { id: request.id, status: "PENDING" },
      data: { status, decidedBy: `staff:${staff.id}`, decidedAt: now, decisionNote: note, payloadCipher: null, resultPartnerId },
    });
    if (done.count === 0) throw new PartnerRefused("That request has been decided already.");
    await partnerAudit(actor, request.partnerId, status === "APPROVED" ? "request.approve" : "request.reject", "request", request.id, { kind: request.kind }, { tx });
  };

  let resultPartner: RequestDecided["resultPartner"] = null;
  let invite: RequestDecided["invite"] = null;
  const payload = (request.payload ?? {}) as Record<string, unknown>;

  if (status === "REJECTED") {
    await controlDb().$transaction(async (tx) => await claim(tx));
  } else if (request.kind === "PROFILE") {
    const { taxIds, ...fields } = cleanProfileFields(payload as ProfileFields);
    if (!Object.keys(fields).length && !taxIds) throw new PartnerRefused("The request holds no change. Reject it instead.");
    await controlDb().$transaction(async (tx) => {
      await claim(tx);
      await tx.partner.update({ where: { id: request.partnerId }, data: { ...fields, ...(taxIds ? { taxIds: taxIds as Prisma.InputJsonValue } : {}) }, select: { id: true } });
    });
  } else if (request.kind === "PAYOUT") {
    if (!request.payloadCipher) throw new PartnerRefused("The details in this request can't be read. Reject it and ask for them again.");
    // Checked again as they are opened: whatever is stored is trusted by nobody.
    const details = cleanPayout(payoutFromJson(openForPartner(request.partnerId, "partner-payout-request", request.payloadCipher)));
    const mask = await controlDb().$transaction(async (tx) => {
      await claim(tx);
      return await writePayout(tx, request.partnerId, details, actor, now);
    });
    await mailPayoutChanged(request.partnerId, mask);
  } else {
    if (!reseller || typeof reseller !== "object") throw new PartnerRefused("Give the new reseller's address and its commission terms.");
    if (request.partner.status === "TERMINATED") throw new PartnerRefused("The distributor is terminated. Reject the request instead.");
    const proposal = payload as Partial<ResellerProposal>;
    const clean = cleanPartnerInput({
      slug: String(reseller.slug ?? ""),
      kind: "RESELLER" as PartnerKind,
      parentSlug: request.partner.slug,
      legalName: String(proposal.legalName ?? ""),
      displayName: String(proposal.displayName ?? ""),
      country: String(proposal.country ?? ""),
      territories: Array.isArray(proposal.territories) ? proposal.territories : [],
      contactName: String(proposal.contactName ?? ""),
      contactEmail: String(proposal.contactEmail ?? ""),
    });
    const terms = await cleanTerms(reseller.terms, { id: null, kind: "RESELLER", territories: clean.territories }, now);
    resultPartner = await createPartnerWith(clean, terms, actor, async (tx, made) => await claim(tx, made.id));
    try {
      invite = await createPartnerUser(resultPartner.id, { email: clean.contactEmail, name: clean.contactName, role: "ADMIN" }, actor);
    } catch (err) {
      // The reseller stands; staff invite its first admin from its page instead.
      if (!(err instanceof PartnerRefused || (err instanceof Error && err.name === "PartnerRefused"))) throw err;
      invite = { error: err.message };
    }
  }

  const requester = request.requestedBy.startsWith("partner:") ? request.requestedBy.slice(8) : null;
  if (requester) {
    const lines = [`Your ${KIND_WORDS[request.kind]} has been ${status === "APPROVED" ? "approved" : "rejected"}.`];
    if (status === "APPROVED" && request.kind === "NEW_RESELLER" && resultPartner) lines.push("", "Its proposed contact has been invited to the partner portal as its admin.");
    if (note) lines.push("", `Note from your partner manager: ${note}`);
    await mailPartnerUsers(request.partnerId, { userIds: [requester] }, `Partner portal: your request was ${status === "APPROVED" ? "approved" : "rejected"}`, lines);
  }
  return { partnerId: request.partnerId, partnerSlug: request.partner.slug, kind: request.kind, status, resultPartner, invite };
}

// ─── Applications ────────────────────────────────────────────────────────────────────────────────

export type ApplicationInput = {
  companyName: string;
  website?: string | null;
  country: string;
  kindWanted: PartnerKind;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  message: string;
};

export type ApplicationField = keyof ApplicationInput;

/** A refusal about one field of the application form — still a PartnerRefused, with the field to show it at. */
export class ApplicationRefused extends PartnerRefused {
  readonly field: ApplicationField;
  constructor(field: ApplicationField, message: string) {
    super(message);
    this.field = field;
  }
}

function field<T>(name: ApplicationField, check: () => T): T {
  try {
    return check();
  } catch (err) {
    if (err instanceof PartnerRefused) throw new ApplicationRefused(name, err.message);
    throw err;
  }
}

/**
 * Stores a "Become a partner" application (spec §10): checked field by field (an ApplicationRefused
 * names the field). The public action handles the honeypot, the limits, the email to sales and the
 * partner audit `application.submit`; `ip` only when the caller's address is known.
 */
export async function recordApplication(input: ApplicationInput, ip: string | null): Promise<{ id: string }> {
  const x = (input ?? {}) as ApplicationInput;
  const companyName = field("companyName", () => requiredText(x.companyName, 2, 160, "Give your company's name (2 to 160 characters)."));
  const website = field("website", () => cleanWebsite(x.website));
  const country = field("country", () => cleanCountry(x.country, "Choose your country."));
  const kindWanted = String(x.kindWanted ?? "").toUpperCase() as PartnerKind;
  if (kindWanted !== "RESELLER" && kindWanted !== "DISTRIBUTOR") throw new ApplicationRefused("kindWanted", "Choose reseller or distributor.");
  const contactName = field("contactName", () => requiredText(x.contactName, 2, 120, "Give your name (2 to 120 characters)."));
  const parsed = parseEmailAddress(String(x.contactEmail ?? ""));
  if (!parsed || parsed.local.length + parsed.domain.length + 1 > 254) throw new ApplicationRefused("contactEmail", "That doesn't look like an email address.");
  if (isDisposableDomain(parsed.domain)) throw new ApplicationRefused("contactEmail", "Use your work address — throwaway addresses can't apply.");
  const contactPhone = field("contactPhone", () => cleanPhone(x.contactPhone));
  const message = manyLines(x.message);
  if (message.length < 20 || message.length > 4000) throw new ApplicationRefused("message", "Tell us about your company in 20 to 4,000 characters.");
  const made = await controlDb().partnerApplication.create({
    data: {
      companyName,
      website,
      country,
      kindWanted,
      contactName,
      contactEmail: `${parsed.local}@${parsed.domain}`,
      contactPhone,
      message,
      ip: ip ? String(ip).slice(0, 64) : null,
    },
    select: { id: true },
  });
  return made;
}

const APPLICATION_STATUSES: PartnerApplicationStatus[] = ["NEW", "REVIEWING", "DECLINED", "SPAM"];

/**
 * Staff's review of an application (console, MANAGERS): its status — never ACCEPTED here, which only
 * `convertApplication` sets — and notes. Audited `application.update` (not visible to any partner).
 */
export async function updateApplication(
  applicationId: string,
  change: { status?: PartnerApplicationStatus; notes?: string | null },
  staff: Staff,
): Promise<{ companyName: string; status: PartnerApplicationStatus; partnerId: string | null }> {
  const id = cleanId(applicationId);
  const app = id ? await controlDb().partnerApplication.findUnique({ where: { id }, select: { id: true, companyName: true, status: true, notes: true, partnerId: true } }) : null;
  if (!app) throw new PartnerRefused(GONE);
  const data: Prisma.PartnerApplicationUpdateInput = {};
  if (change?.status !== undefined) {
    const status = String(change.status).toUpperCase() as PartnerApplicationStatus;
    if (status === "ACCEPTED") throw new PartnerRefused("Create a partner from it instead — that accepts it.");
    if (!APPLICATION_STATUSES.includes(status)) throw new PartnerRefused("Choose new, reviewing, declined or spam.");
    if (app.status === "ACCEPTED") throw new PartnerRefused("It has been turned into a partner already, so it stays accepted.");
    if (status !== app.status) data.status = status;
  }
  if (change?.notes !== undefined) {
    const notes = manyLines(change.notes) || null;
    if (notes && notes.length > 4000) throw new PartnerRefused("Keep the notes to 4,000 characters.");
    if (notes !== app.notes) data.notes = notes;
  }
  if (!Object.keys(data).length) throw new PartnerRefused("Nothing to change.");
  const actor = staffActor(staff);
  const updated = await controlDb().$transaction(async (tx) => {
    const row = await tx.partnerApplication.update({ where: { id: app.id }, data: { ...data, handledBy: actorRef(actor) }, select: { companyName: true, status: true, partnerId: true } });
    await partnerAudit(actor, app.partnerId, "application.update", "application", app.id, { companyName: app.companyName, ...(data.status ? { status: data.status } : {}), ...(data.notes !== undefined ? { notes: true } : {}) }, { tx, visibleToPartner: false });
    return row;
  });
  return updated;
}

/**
 * Turns an application into a partner (console, MANAGERS): the partner and its first terms made as
 * `createPartner` makes them, and the application ACCEPTED and linked to it, in one transaction.
 */
export async function convertApplication(applicationId: string, input: PartnerInput, terms: TermsInput, staff: Staff, now: Date = new Date()): Promise<{ id: string; slug: string }> {
  const id = cleanId(applicationId);
  const app = id ? await controlDb().partnerApplication.findUnique({ where: { id }, select: { id: true, status: true, partnerId: true, companyName: true } }) : null;
  if (!app) throw new PartnerRefused(GONE);
  if (app.partnerId || app.status === "ACCEPTED") throw new PartnerRefused("That application has been turned into a partner already.");
  const clean = cleanPartnerInput(input);
  const cleanT = await cleanTerms(terms, { id: null, kind: clean.kind, territories: clean.territories }, now);
  const actor = staffActor(staff);
  return createPartnerWith(clean, cleanT, actor, async (tx, made) => {
    const done = await tx.partnerApplication.updateMany({ where: { id: app.id, partnerId: null, status: { not: "ACCEPTED" } }, data: { partnerId: made.id, status: "ACCEPTED", handledBy: actorRef(actor) } });
    if (done.count === 0) throw new PartnerRefused("That application has been turned into a partner already.");
    await partnerAudit(actor, made.id, "application.convert", "application", app.id, { companyName: app.companyName, partner: made.slug }, { tx, visibleToPartner: false });
  });
}
