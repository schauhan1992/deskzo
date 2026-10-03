"use server";

import type { PartnerApplicationStatus, PartnerStatus, StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import type { RawParams } from "@/lib/console-shared/params";
import { parsePartnerDirectoryFilters } from "@/lib/console-shared/partner-params";
import { PAYERS } from "@/lib/console-shared/roles";
import type { CsvExport } from "@/lib/console-shared/types";
import { reviewAttribution, setAttribution } from "@/lib/partners/attribution";
import { partnerDirectoryCsv, partnerPicker, type PartnerPickerRow } from "@/lib/partners/console-data";
import { partnerRefusal } from "@/lib/partners/guard";
import { decideDeal } from "@/lib/partners/referrals";
import { createPartner, partnerIdBySlug, setPartnerStatus, staffActor, updatePartner } from "@/lib/partners/registry";
import { convertApplication, decideRequest, updateApplication } from "@/lib/partners/requests";
import { setPartnerSettings, type PartnerSettings } from "@/lib/partners/settings";
import { setPartnerTerms } from "@/lib/partners/terms";
import { PartnerRefused, type PartnerInput, type TermsInput } from "@/lib/partners/types";
import { createPartnerUser, deactivatePartnerUser, newPartnerSetupLink, partnerOfUser, reactivatePartnerUser, resetPartnerUserTwoFactor } from "@/lib/partners/users";
import { MANAGERS, OWNERS, SELLERS, cleanText, consoleAudit, consoleAuditMany, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { indiaClock } from "@/lib/time/zone";

/**
 * The console's partner programme (spec §9.4): partners, their status, terms and people, which
 * workspace belongs to which partner, deal registrations, partner requests, applications, the CSV of
 * the directory and the programme settings. Money that leaves the platform — payout details and
 * statements — is console-commissions.ts.
 *
 *   MANAGERS   create and edit partners, their status, their portal users; applications; profile
 *              and reseller requests; the directory's CSV (the partners' contacts)
 *   SELLERS    terms, attribution changes and reviews, deal decisions, the partner picker
 *   PAYERS     payout requests (checked after the request is read: its kind decides)
 *   OWNERS     the programme settings
 *
 * Each change goes through the partner library — which checks everything again and writes the
 * partner's own activity log as "Platform staff: <name>" — then writes the platform audit exactly
 * once, naming the partner by slug (`detail.partner`), and refreshes the console. The detail never
 * holds bank details, codes, hashes, what a partner's request carries or an email's body.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    // Every partner library's refusal (ApplicationRefused included) is a PartnerRefused.
    const partner = partnerRefusal(err);
    if (partner) return partner;
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

// ─── Inputs, re-coerced (the libraries check them again, in full) ────────────────────────────────

const id = (v: unknown) => cleanText(v, 40);
const optional = (v: unknown, max: number) => (v === null || v === undefined ? null : cleanText(v, max));
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Strings from a list, each cut, at most `cap` — a longer list is refused rather than cut. */
function strings(v: unknown, max: number, cap: number): string[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) return typeof v === "string" ? v.split(/[\s,]+/).map((s) => cleanText(s, max)).filter(Boolean) : [];
  if (v.length > cap) throw new PartnerRefused(`At most ${cap} of those.`);
  return v.map((s) => cleanText(s, max)).filter(Boolean);
}

function rows<T>(v: unknown, cap: number, map: (row: Record<string, unknown>) => T): T[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new PartnerRefused("That is not a list.");
  if (v.length > cap) throw new PartnerRefused(`At most ${cap} of those.`);
  return v.map((row) => map(obj(row)));
}

/** A whole number as typed, for the library to check; NaN for anything else (refused there), null for nothing. */
function whole(v: unknown): number | null {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  if (typeof v === "number") return v;
  return typeof v === "string" && /^\s*-?\d{1,6}\s*$/.test(v) ? Number(v.trim()) : NaN;
}

/** An address; in an edit (`partial`) a line left out stays as it is. */
function addressInput(v: unknown, partial: boolean): PartnerInput["address"] {
  const a = obj(v);
  const line = (key: string, max: number) => (partial && a[key] === undefined ? undefined : optional(a[key], max));
  return { line1: line("line1", 200), line2: line("line2", 200), city: line("city", 120), region: line("region", 120), postalCode: line("postalCode", 20) };
}

/** A partner form, field by field — only the fields that came (`partial`), or all of them. */
function partnerInput(v: unknown, partial: boolean): Partial<PartnerInput> & { notes?: string | null } {
  const x = obj(v);
  const out: Partial<PartnerInput> & { notes?: string | null } = {};
  const has = (k: string) => !partial || x[k] !== undefined;
  if (has("slug")) out.slug = cleanText(x.slug, 60);
  if (has("kind")) out.kind = cleanText(x.kind, 20).toUpperCase() as PartnerInput["kind"];
  if (has("parentSlug")) out.parentSlug = optional(x.parentSlug, 60);
  if (has("legalName")) out.legalName = cleanText(x.legalName, 300);
  if (has("displayName")) out.displayName = cleanText(x.displayName, 200);
  if (has("country")) out.country = cleanText(x.country, 4);
  if (has("territories")) out.territories = strings(x.territories, 4, 500);
  if (has("contactName")) out.contactName = cleanText(x.contactName, 200);
  if (has("contactEmail")) out.contactEmail = cleanText(x.contactEmail, 300);
  if (has("contactPhone")) out.contactPhone = optional(x.contactPhone, 60);
  if (has("website")) out.website = optional(x.website, 300);
  if (has("address")) out.address = addressInput(x.address, partial);
  if (has("taxIds")) out.taxIds = rows(x.taxIds, 4, (t) => ({ kind: cleanText(t.kind, 20), value: cleanText(t.value, 60) }));
  if (has("publicListing")) out.publicListing = x.publicListing === true;
  if (has("publicBlurb")) out.publicBlurb = optional(x.publicBlurb, 400);
  if (partial && x.notes !== undefined) out.notes = optional(x.notes, 5000);
  return out;
}

function termsInput(v: unknown): TermsInput {
  const x = obj(v);
  return {
    effectiveFrom: optional(x.effectiveFrom, 20),
    defaultRate: cleanText(x.defaultRate, 12),
    newRate: optional(x.newRate, 12),
    renewalRate: optional(x.renewalRate, 12),
    newMonths: whole(x.newMonths),
    durationMonths: whole(x.durationMonths),
    overrideRate: optional(x.overrideRate, 12),
    territoryRate: optional(x.territoryRate, 12),
    planRates: rows(x.planRates, 50, (r) => ({ planKey: cleanText(r.planKey, 64), rate: cleanText(r.rate, 12) })),
    countryRates: rows(x.countryRates, 50, (r) => ({ country: cleanText(r.country, 4), rate: cleanText(r.rate, 12) })),
    note: optional(x.note, 600),
  };
}

/** The page's query string, for an export: strings only, sensible keys, cut. */
function rawParams(params: unknown): RawParams {
  const raw: RawParams = {};
  for (const [key, value] of Object.entries(obj(params)).slice(0, 40)) {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) raw[key] = value.slice(0, 200);
  }
  return raw;
}

/** The partner's slug for the audit entry — and a refusal when it is gone. */
async function slugOf(partnerId: string): Promise<string> {
  const row = partnerId ? await controlDb().partner.findUnique({ where: { id: partnerId }, select: { slug: true } }) : null;
  if (!row) throw new PartnerRefused("That partner no longer exists.");
  return row.slug;
}

/** One of a partner's portal users, named by id: whose, and their address (for the audit entry). */
async function partnerUser(userId: string): Promise<{ userId: string; partnerId: string; partnerSlug: string; email: string }> {
  const uid = id(userId);
  const owner = uid ? await partnerOfUser(uid) : null;
  const user = owner ? await controlDb().partnerUser.findUnique({ where: { id: owner.userId }, select: { email: true } }) : null;
  if (!owner || !user) throw new PartnerRefused("That account no longer exists.");
  return { ...owner, email: user.email };
}

// ─── Partners ────────────────────────────────────────────────────────────────────────────────────

/** A new partner with its first terms (spec §3.1, §3.3). It starts ONBOARDING. */
export async function consoleCreatePartner(input: PartnerInput & { terms: TermsInput }): Promise<ConsoleResult<{ slug: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const partner = partnerInput(input, false) as PartnerInput;
    const made = await createPartner(partner, termsInput(obj(input).terms), staff);
    await consoleAudit(staff, "partner.create", { partner: made.slug, kind: partner.kind });
    revalidateConsole();
    return { slug: made.slug };
  });
}

/** Staff's edit of a partner: any of its details, and the staff-only notes. Fields left out stay as they are. */
export async function consoleUpdatePartner(partnerId: string, input: Partial<PartnerInput> & { notes?: string | null }): Promise<ConsoleResult<{ slug: string; changed: string[] }>> {
  return asStaff(MANAGERS, async (staff) => {
    const done = await updatePartner(id(partnerId), partnerInput(input, true), staff);
    await consoleAudit(staff, "partner.update", { partner: done.slug, fields: done.changed });
    revalidateConsole();
    return done;
  });
}

/** Onboarding → active, active ↔ suspended, anything → terminated (spec §3.2), with staff's reason. */
export async function consoleSetPartnerStatus(partnerId: string, status: PartnerStatus, reason: string): Promise<ConsoleResult<{ slug: string; from: PartnerStatus; to: PartnerStatus }>> {
  return asStaff(MANAGERS, async (staff) => {
    const done = await setPartnerStatus(id(partnerId), cleanText(status, 20).toUpperCase() as PartnerStatus, cleanText(reason, 600), staff);
    await consoleAudit(staff, "partner.status", { partner: done.slug, from: done.from, to: done.to, reason: cleanText(reason, 500), ...(done.ended ? { ended: done.ended } : {}) });
    revalidateConsole();
    return { slug: done.slug, from: done.from, to: done.to };
  });
}

/** New terms from a day on (today means from now; never backdated). */
export async function consoleSetPartnerTerms(partnerId: string, terms: TermsInput): Promise<ConsoleResult<{ id: string; effectiveFrom: Date }>> {
  return asStaff(SELLERS, async (staff) => {
    const pid = id(partnerId);
    const slug = await slugOf(pid);
    const row = await setPartnerTerms(pid, termsInput(terms), staff);
    // Rates stay on the terms page: the platform log is read by roles that see no money. The day is
    // India's, as the terms' own (the programme's money days, src/lib/partners/terms.ts).
    await consoleAudit(staff, "partner.terms", { partner: slug, from: indiaClock.dateKey(row.effectiveFrom) });
    revalidateConsole();
    return { id: row.id, effectiveFrom: row.effectiveFrom };
  });
}

// ─── The partner's portal users ──────────────────────────────────────────────────────────────────

/**
 * The partner's first (or another) ADMIN: the setup link is emailed to them and shown once to the
 * staff member, to pass on if the mail does not arrive.
 */
export async function consoleInvitePartnerAdmin(partnerId: string, input: { email: string; name: string }): Promise<ConsoleResult<{ setupUrl: string; emailed: boolean }>> {
  return asStaff(MANAGERS, async (staff) => {
    const pid = id(partnerId);
    const slug = await slugOf(pid);
    const x = obj(input);
    const made = await createPartnerUser(pid, { email: cleanText(x.email, 300), name: cleanText(x.name, 200), role: "ADMIN" }, staffActor(staff));
    await consoleAudit(staff, "partner.user.invite", { partner: slug, email: cleanText(x.email, 300).toLowerCase(), role: "ADMIN", partnerUserId: made.id, emailed: made.emailed });
    revalidateConsole();
    return { setupUrl: made.setupUrl, emailed: made.emailed };
  });
}

/** A fresh setup link for one of a partner's users — emailed to them only, never shown here. */
export async function consolePartnerUserLink(userId: string): Promise<ConsoleResult<{ emailed: boolean }>> {
  return asStaff(MANAGERS, async (staff) => {
    const user = await partnerUser(userId);
    const sent = await newPartnerSetupLink(user.partnerId, user.userId, staffActor(staff), false);
    await consoleAudit(staff, "partner.user.setup-link", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId, emailed: sent.emailed });
    revalidateConsole();
    return { emailed: sent.emailed };
  });
}

/** Switches a partner's user off and signs them out (the partner's last active admin cannot be). */
export async function consoleDeactivatePartnerUser(userId: string): Promise<ConsoleResult> {
  return asStaff(MANAGERS, async (staff) => {
    const user = await partnerUser(userId);
    await deactivatePartnerUser(user.partnerId, user.userId, staffActor(staff));
    await consoleAudit(staff, "partner.user.deactivate", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId });
    revalidateConsole();
    return null;
  });
}

/** Switches a user back on as a new starter; their new setup link is emailed to them, never shown here. */
export async function consoleReactivatePartnerUser(userId: string): Promise<ConsoleResult<{ emailed: boolean }>> {
  return asStaff(MANAGERS, async (staff) => {
    const user = await partnerUser(userId);
    const done = await reactivatePartnerUser(user.partnerId, user.userId, staffActor(staff));
    await consoleAudit(staff, "partner.user.reactivate", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId, emailed: done.emailed });
    revalidateConsole();
    return { emailed: done.emailed };
  });
}

/** A lost phone: the user's authenticator is forgotten and they are signed out everywhere. */
export async function consoleResetPartnerUserTwoFactor(userId: string): Promise<ConsoleResult> {
  return asStaff(MANAGERS, async (staff) => {
    const user = await partnerUser(userId);
    await resetPartnerUserTwoFactor(user.partnerId, user.userId, staffActor(staff));
    await consoleAudit(staff, "partner.user.two-factor.reset", { partner: user.partnerSlug, email: user.email, partnerUserId: user.userId });
    revalidateConsole();
    return null;
  });
}

// ─── Which partner a workspace belongs to ────────────────────────────────────────────────────────

/**
 * Moves a workspace to a partner (`partnerSlug`), or makes it direct (null), from now on, with a reason
 * (10–500 characters). Outside the partner's territories is allowed — `outsideTerritory` says so.
 */
export async function consoleSetAttribution(
  tenantId: string,
  input: { partnerSlug: string | null; reason: string; commissionable: boolean },
): Promise<ConsoleResult<{ from: string | null; to: string | null; commissionable: boolean; outsideTerritory: boolean }>> {
  return asStaff(SELLERS, async (staff) => {
    const x = obj(input);
    const slug = x.partnerSlug === null || x.partnerSlug === undefined ? "" : cleanText(x.partnerSlug, 60).toLowerCase();
    let partnerId: string | null = null;
    if (slug) {
      partnerId = await partnerIdBySlug(slug);
      if (!partnerId) throw new PartnerRefused("That partner no longer exists.");
    }
    const reason = cleanText(x.reason, 600);
    const done = await setAttribution(id(tenantId), { partnerId, reason, commissionable: x.commissionable !== false }, staff);
    await consoleAudit(
      staff,
      "partner.attribution",
      { partner: done.to ?? done.from, from: done.from, to: done.to, commissionable: done.commissionable, reason, workspace: done.tenantSlug, ...(done.outsideTerritory ? { outsideTerritory: true } : {}) },
      id(tenantId),
    );
    revalidateConsole();
    return { from: done.from, to: done.to, commissionable: done.commissionable, outsideTerritory: done.outsideTerritory };
  });
}

/** A flagged attribution looked at: it leaves the review queue. */
export async function consoleReviewAttribution(attributionId: string): Promise<ConsoleResult> {
  return asStaff(SELLERS, async (staff) => {
    const done = await reviewAttribution(id(attributionId), staff);
    await consoleAudit(staff, "partner.attribution.review", { partner: done.partnerSlug, workspace: done.tenantSlug, attribution: id(attributionId) }, done.tenantId);
    revalidateConsole();
    return null;
  });
}

// ─── Deals, requests, applications ───────────────────────────────────────────────────────────────

/** Approves (protected for `partners.dealDays`) or declines a deal registration; the note is shown to the partner. */
export async function consoleDecideDeal(dealId: string, decision: "APPROVE" | "DECLINE", note?: string | null): Promise<ConsoleResult<{ status: string; expiresAt: Date | null }>> {
  return asStaff(SELLERS, async (staff) => {
    const d = cleanText(decision, 10).toUpperCase();
    if (d !== "APPROVE" && d !== "DECLINE") throw new PartnerRefused("Approve or decline it.");
    const done = await decideDeal(id(dealId), d, optional(note, 600), staff);
    await consoleAudit(staff, "partner.deal.decide", { partner: done.partnerSlug, decision: d, deal: id(dealId), companyName: done.companyName, domain: done.domain, status: done.status });
    revalidateConsole();
    return { status: done.status, expiresAt: done.expiresAt };
  });
}

/**
 * Approves or rejects a partner's request. The role depends on what it asks, so the request is read
 * first: new bank details (PAYOUT) need PAYERS; a profile change or a new reseller, MANAGERS. A new
 * reseller's approval needs `reseller` (its console address and first terms); its proposed contact is
 * then invited as its ADMIN — the setup link comes back once, or why the invitation was refused.
 */
export async function consoleDecideRequest(
  requestId: string,
  decision: "APPROVE" | "REJECT",
  note?: string | null,
  reseller?: { slug: string; terms: TermsInput } | null,
): Promise<ConsoleResult<{ kind: string; status: string; resultPartner: { slug: string } | null; invite: { setupUrl: string; emailed: boolean } | { error: string } | null }>> {
  // MANAGERS and PAYERS together are SELLERS; the request's kind narrows it below.
  return asStaff(SELLERS, async (staff) => {
    const rid = id(requestId);
    const request = rid ? await controlDb().partnerRequest.findUnique({ where: { id: rid }, select: { kind: true } }) : null;
    if (!request) throw new PartnerRefused("That no longer exists.");
    const allowed = request.kind === "PAYOUT" ? PAYERS : MANAGERS;
    if (!allowed.includes(staff.role)) throw new StaffRefused("Your role cannot do that.");
    const d = cleanText(decision, 10).toUpperCase();
    if (d !== "APPROVE" && d !== "REJECT") throw new PartnerRefused("Approve or reject it.");
    const r = reseller && typeof reseller === "object" ? { slug: cleanText(obj(reseller).slug, 60), terms: termsInput(obj(reseller).terms) } : null;
    const done = await decideRequest(rid, d, optional(note, 600), staff, r);
    await consoleAudit(staff, "partner.request.decide", {
      partner: done.partnerSlug,
      decision: d,
      request: rid,
      kind: done.kind,
      status: done.status,
      ...(done.resultPartner ? { reseller: done.resultPartner.slug } : {}),
      ...(done.invite ? { invited: "setupUrl" in done.invite } : {}),
    });
    revalidateConsole();
    return { kind: done.kind, status: done.status, resultPartner: done.resultPartner ? { slug: done.resultPartner.slug } : null, invite: done.invite };
  });
}

/** An application's status (new, reviewing, declined, spam — accepted only by turning it into a partner) and staff's notes. */
export async function consoleUpdateApplication(applicationId: string, change: { status?: PartnerApplicationStatus; notes?: string | null }): Promise<ConsoleResult<{ status: PartnerApplicationStatus }>> {
  return asStaff(MANAGERS, async (staff) => {
    const x = obj(change);
    const aid = id(applicationId);
    const done = await updateApplication(
      aid,
      { ...(x.status !== undefined ? { status: cleanText(x.status, 20).toUpperCase() as PartnerApplicationStatus } : {}), ...(x.notes !== undefined ? { notes: optional(x.notes, 5000) } : {}) },
      staff,
    );
    const partner = done.partnerId ? await controlDb().partner.findUnique({ where: { id: done.partnerId }, select: { slug: true } }) : null;
    await consoleAudit(staff, "partner.application.update", {
      application: aid,
      companyName: done.companyName,
      status: done.status,
      ...(x.notes !== undefined ? { notes: true } : {}),
      ...(partner ? { partner: partner.slug } : {}),
    });
    revalidateConsole();
    return { status: done.status };
  });
}

/** Turns an application into a partner with its first terms, and marks it accepted — both, or neither. */
export async function consoleConvertApplication(applicationId: string, input: PartnerInput & { terms: TermsInput }): Promise<ConsoleResult<{ slug: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const aid = id(applicationId);
    const partner = partnerInput(input, false) as PartnerInput;
    const made = await convertApplication(aid, partner, termsInput(obj(input).terms), staff);
    // One change, two facts: the application was accepted, and a partner was created.
    await consoleAuditMany(staff, [
      { action: "partner.application.convert", detail: { partner: made.slug, application: aid }, tenantId: null },
      { action: "partner.create", detail: { partner: made.slug, kind: partner.kind, application: aid }, tenantId: null },
    ]);
    revalidateConsole();
    return { slug: made.slug };
  });
}

// ─── The directory's CSV, the picker ─────────────────────────────────────────────────────────────

/** The directory as filtered on screen (the page's query string), as CSV: the partners' contacts, so MANAGERS only, and recorded. */
export async function consoleExportPartners(params: Record<string, string>): Promise<ConsoleResult<CsvExport>> {
  return asStaff(MANAGERS, async (staff) => {
    const filters = parsePartnerDirectoryFilters(rawParams(params));
    const out = await partnerDirectoryCsv(filters);
    const asked: Partial<typeof filters> = { ...filters };
    delete asked.page;
    await consoleAudit(staff, "export.partners", { filters: asked, rows: out.rows });
    return out;
  });
}

/** Partners that are not terminated, matching what was typed — the attribution and adjustment dialogs' search. */
export async function consolePartnerPicker(q: string): Promise<ConsoleResult<PartnerPickerRow[]>> {
  return asStaff(SELLERS, async () => partnerPicker(cleanText(q, 100)));
}

// ─── Programme settings ──────────────────────────────────────────────────────────────────────────

const SETTING_FIELDS = ["twoFactor", "statementDay", "dealDays", "refCookieDays", "applications", "directory", "clawbackMonths", "twoPersonPayout"] as const;

/** The programme settings (spec §11, owner decisions O3 and O4). Only what differs from what is in force is written. */
export async function consoleSetPartnerSettings(input: Partial<Record<(typeof SETTING_FIELDS)[number], unknown>>): Promise<ConsoleResult<{ changed: string[]; settings: PartnerSettings }>> {
  return asStaff(OWNERS, async (staff) => {
    const x = obj(input);
    const given: Record<string, string | number | boolean> = {};
    for (const field of SETTING_FIELDS) {
      const v = x[field];
      if (typeof v === "boolean" || typeof v === "number") given[field] = v;
      else if (typeof v === "string") given[field] = cleanText(v, 20);
    }
    const done = await setPartnerSettings(given, staff.id);
    if (!done.changed.length) throw new PartnerRefused("Nothing to change.");
    const now = done.settings as unknown as Record<string, unknown>;
    const to = Object.fromEntries(done.changed.map((key) => [key, now[key.slice("partners.".length)]]));
    await consoleAudit(staff, "partner.settings", { changed: done.changed, to });
    revalidateConsole();
    return { changed: done.changed, settings: done.settings };
  });
}
