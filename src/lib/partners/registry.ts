import { Prisma, type PartnerKind, type PartnerRole, type PartnerStatus } from "@deskzo/control-client";
import { parseEmailAddress } from "@/lib/email-verification";
import { COUNTRIES } from "@/lib/geo/countries";
import { actorRef, partnerAudit, type PartnerActor } from "@/lib/partners/audit";
import { assertNoTerritoryOverlap, cleanTerms, termsAt, writeTerms, type CleanTerms } from "@/lib/partners/terms";
import { PartnerRefused, TAX_ID_KINDS, type PartnerInput, type PartnerMe, type TaxIdKind, type TermsInput } from "@/lib/partners/types";
import { revokePartnerSessions } from "@/lib/partners/users";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import type { Staff } from "@/lib/platform/staff-session";
import { indiaClock } from "@/lib/time/zone";

/**
 * The partners themselves (partners): creating and editing them, their status, and the public
 * "Find a partner" directory.
 *
 *   · Staff (console, MANAGERS) create a partner with its first terms in one go; it starts ONBOARDING.
 *   · A reseller may sit under one distributor, inside that distributor's territories; shrinking a
 *     distributor's territories is refused while one of its resellers still sells outside them.
 *   · A partner's own ADMIN edits only the direct fields (display name, phone, website, the public
 *     listing); legal and contact details and tax ids change through a PROFILE request (requests.ts).
 *   · Status (spec §3.2): ONBOARDING → ACTIVE (needs terms in force and an active admin), ACTIVE ↔
 *     SUSPENDED, any → TERMINATED (final: sessions end, live codes and links end, open deals and
 *     pending requests are withdrawn; a distributor with live resellers cannot be terminated).
 *
 * Every function here writes the partner audit with the actor it is given and sends the partner's
 * emails; the console actions write the platform audit. Refusals are PartnerRefused.
 */

// ─── Small shared helpers (the other partner libraries use them too) ────────────────────────────

/** A staff member from the console, as the partner audit's actor. */
export const staffActor = (staff: Staff): PartnerActor => ({ kind: "staff", id: staff.id, name: staff.name });

/**
 * The signed-in portal user as the partner audit's actor — the same as guard.ts's `partnerActor`,
 * kept here so the libraries do not load the portal's page and navigation helpers.
 */
export const meActor = (me: PartnerMe): PartnerActor => ({ kind: "partner", id: me.id, name: me.name, email: me.email, partnerId: me.partner.id });

/** Staff from the console, or an actor as it is (the CLI passes `{ kind: "script" }`). */
export const actorOf = (who: Staff | PartnerActor): PartnerActor => ("kind" in who ? who : staffActor(who));

export const cleanId = (value: unknown): string => String(value ?? "").trim().slice(0, 40);

/** One line of text: control characters become spaces, runs of spaces one, the ends trimmed. */
export function oneLine(raw: unknown): string {
  let text = "";
  for (const ch of String(raw ?? "")) {
    const code = ch.codePointAt(0) ?? 0;
    text += code < 32 || code === 127 ? " " : ch;
  }
  return text.replace(/\s{2,}/g, " ").trim();
}

/** Several lines of text: line breaks kept (at most one blank line in a row), other control characters dropped. */
export function manyLines(raw: unknown): string {
  let text = "";
  for (const ch of String(raw ?? "").replace(/\r\n?/g, "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    text += code === 10 ? ch : code < 32 || code === 127 ? " " : ch;
  }
  return text
    .split("\n")
    .map((l) => l.replace(/\s{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function requiredText(raw: unknown, min: number, max: number, refusal: string): string {
  const text = oneLine(raw);
  if (text.length < min || text.length > max) throw new PartnerRefused(refusal);
  return text;
}

export function optionalText(raw: unknown, max: number, refusal: string): string | null {
  const text = oneLine(raw);
  if (!text) return null;
  if (text.length > max) throw new PartnerRefused(refusal);
  return text;
}

/** An address, lower-cased — or a refusal. */
export function cleanEmail(raw: unknown, refusal = "That doesn't look like an email address."): string {
  const parsed = parseEmailAddress(String(raw ?? ""));
  const email = parsed ? `${parsed.local}@${parsed.domain}` : "";
  if (!email || email.length > 254) throw new PartnerRefused(refusal);
  return email;
}

/** A website: "acme.example" becomes "https://acme.example"; only http(s), at most 200 characters. */
export function cleanWebsite(raw: unknown): string | null {
  let text = oneLine(raw);
  if (!text) return null;
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new PartnerRefused("That doesn't look like a website address.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname.includes(".") || url.username || url.password) throw new PartnerRefused("That doesn't look like a website address.");
  const clean = text.replace(/^HTTPS?:\/\//i, (m) => m.toLowerCase());
  if (clean.length > 200) throw new PartnerRefused("Keep the website address to 200 characters.");
  return clean;
}

const COUNTRY_CODES = new Set(COUNTRIES.map((c) => c.code));
const COUNTRY_NAMES = new Map(COUNTRIES.map((c) => [c.code, c.name]));

export function cleanCountry(raw: unknown, refusal = "Choose a country from the list."): string {
  const code = String(raw ?? "").trim().toUpperCase();
  if (!COUNTRY_CODES.has(code)) throw new PartnerRefused(refusal);
  return code;
}

/** Country codes: upper-cased, each once, every one a real country, at least one. */
export function cleanTerritories(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  if (list.length > 500) throw new PartnerRefused("That is more territories than there are countries.");
  const out: string[] = [];
  for (const item of list) {
    const code = String(item ?? "").trim().toUpperCase();
    if (!code) continue;
    if (!COUNTRY_CODES.has(code)) throw new PartnerRefused(`${code.slice(0, 8)} is not a country code.`);
    if (!out.includes(code)) out.push(code);
  }
  if (!out.length) throw new PartnerRefused("Choose at least one territory.");
  if (out.length > 250) throw new PartnerRefused("At most 250 territories.");
  return out;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** Tax ids: at most four `{ kind, value }`; GSTIN and PAN checked for shape (never looked up). */
export function cleanTaxIds(raw: unknown): { kind: TaxIdKind; value: string }[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new PartnerRefused("Tax ids are a list.");
  if (raw.length > 4) throw new PartnerRefused("At most four tax ids.");
  const out: { kind: TaxIdKind; value: string }[] = [];
  for (const item of raw) {
    const kind = String((item as { kind?: unknown } | null)?.kind ?? "").trim().toUpperCase() as TaxIdKind;
    if (!(TAX_ID_KINDS as readonly string[]).includes(kind)) throw new PartnerRefused(`Choose what kind of tax id each one is: ${TAX_ID_KINDS.join(", ")}.`);
    let value = oneLine((item as { value?: unknown }).value);
    if (kind === "GSTIN" || kind === "PAN" || kind === "VAT") value = value.replace(/\s+/g, "").toUpperCase();
    if (value.length < 3 || value.length > 40) throw new PartnerRefused(`A ${kind} is 3 to 40 characters.`);
    if (kind === "GSTIN" && !GSTIN.test(value)) throw new PartnerRefused("That GSTIN is not in the right format (15 characters, like 27ABCDE1234F1Z5).");
    if (kind === "PAN" && !PAN.test(value)) throw new PartnerRefused("That PAN is not in the right format (10 characters, like ABCDE1234F).");
    if (!out.some((t) => t.kind === kind && t.value === value)) out.push({ kind, value });
  }
  return out;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** A partner's address in the console: lower-case, 3–40, like a workspace name, never "new" or "requests". */
export function cleanSlug(raw: unknown): string {
  const slug = String(raw ?? "").trim().toLowerCase();
  if (!SLUG.test(slug)) throw new PartnerRefused("Use 3–40 lower-case letters, digits and hyphens, not starting or ending with a hyphen.");
  if (slug === "new" || slug === "requests") throw new PartnerRefused("That address is reserved.");
  return slug;
}

const isUniqueViolation = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError || (err instanceof Error && err.name === "PrismaClientKnownRequestError")) && (err as { code?: unknown }).code === "P2002";

// ─── Emails to a partner's people ────────────────────────────────────────────────────────────────

/**
 * One email to each active user of a partner with one of `roles` (or among `userIds`) — each their
 * own, so no address is shown to another. A failure is logged and never thrown: the change it is
 * about is already stored. Returns how many were sent.
 */
export async function mailPartnerUsers(partnerId: string, who: { roles?: readonly PartnerRole[]; userIds?: string[] }, subject: string, lines: string[]): Promise<number> {
  let sent = 0;
  try {
    const users = await controlDb().partnerUser.findMany({
      where: {
        partnerId: cleanId(partnerId),
        active: true,
        ...(who.roles ? { role: { in: [...who.roles] } } : {}),
        ...(who.userIds ? { id: { in: who.userIds.map(cleanId) } } : {}),
      },
      select: { email: true, name: true },
    });
    for (const user of users) {
      try {
        await sendPlatformMail({ to: user.email, subject, text: [`Hello ${user.name},`, "", ...lines].join("\n") });
        sent += 1;
      } catch (err) {
        console.error(`[partners] "${subject}" could not be sent: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
      }
    }
  } catch (err) {
    console.error(`[partners] "${subject}" could not be sent: ${err instanceof Error ? err.name : "error"}`);
  }
  return sent;
}

// ─── Checking a partner ──────────────────────────────────────────────────────────────────────────

/** A partner as checked, in the columns it is stored in. `parentSlug` is resolved to a distributor when it is written. */
export type CleanPartner = {
  slug: string;
  kind: PartnerKind;
  parentSlug: string | null;
  legalName: string;
  displayName: string;
  country: string;
  territories: string[];
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  taxIds: { kind: TaxIdKind; value: string }[];
  publicListing: boolean;
  publicBlurb: string | null;
};

export const cleanDisplayName = (raw: unknown) => requiredText(raw, 2, 120, "Give the name to show (2 to 120 characters).");
export const cleanLegalName = (raw: unknown) => requiredText(raw, 2, 200, "Give the company's legal name (2 to 200 characters).");
export const cleanContactName = (raw: unknown) => requiredText(raw, 2, 120, "Give the contact's name (2 to 120 characters).");
export const cleanPhone = (raw: unknown) => optionalText(raw, 32, "Keep the phone number to 32 characters.");
export const cleanBlurb = (raw: unknown) => optionalText(raw, 300, "Keep the public description to 300 characters.");

export function cleanAddress(raw: PartnerInput["address"] | null | undefined) {
  const a = raw ?? {};
  return {
    addressLine1: optionalText(a.line1, 200, "Keep each address line to 200 characters."),
    addressLine2: optionalText(a.line2, 200, "Keep each address line to 200 characters."),
    city: optionalText(a.city, 120, "Keep the city to 120 characters."),
    region: optionalText(a.region, 120, "Keep the state or region to 120 characters."),
    postalCode: optionalText(a.postalCode, 20, "Keep the postal code to 20 characters."),
  };
}

/** Everything a partner form sends, checked (pure — the distributor and the address being free are checked when it is written). */
export function cleanPartnerInput(input: PartnerInput): CleanPartner {
  if (!input || typeof input !== "object") throw new PartnerRefused("Give the partner's details.");
  const slug = cleanSlug(input.slug);
  const kind = String(input.kind ?? "").toUpperCase() as PartnerKind;
  if (kind !== "DISTRIBUTOR" && kind !== "RESELLER") throw new PartnerRefused("Choose distributor or reseller.");
  const parentText = String(input.parentSlug ?? "").trim().toLowerCase();
  if (kind === "DISTRIBUTOR" && parentText) throw new PartnerRefused("A distributor has no distributor above it.");
  const parentSlug = parentText ? cleanSlug(parentText) : null;
  if (parentSlug === slug) throw new PartnerRefused("A reseller can't be its own distributor.");
  return {
    slug,
    kind,
    parentSlug,
    legalName: cleanLegalName(input.legalName),
    displayName: cleanDisplayName(input.displayName),
    country: cleanCountry(input.country, "Choose the country the company is established in."),
    territories: cleanTerritories(input.territories),
    contactName: cleanContactName(input.contactName),
    contactEmail: cleanEmail(input.contactEmail, "The contact's email doesn't look like an email address."),
    contactPhone: cleanPhone(input.contactPhone),
    website: cleanWebsite(input.website),
    ...cleanAddress(input.address),
    taxIds: cleanTaxIds(input.taxIds),
    publicListing: input.publicListing === true,
    publicBlurb: cleanBlurb(input.publicBlurb),
  };
}

/** The distributor a reseller sits under — existing, not terminated, and holding every one of the reseller's territories. */
async function parentFor(tx: Prisma.TransactionClient, clean: CleanPartner, selfId: string | null): Promise<string | null> {
  if (clean.kind !== "RESELLER" || !clean.parentSlug) return null;
  const parent = await tx.partner.findUnique({ where: { slug: clean.parentSlug }, select: { id: true, kind: true, status: true, displayName: true, territories: true } });
  if (!parent || parent.kind !== "DISTRIBUTOR" || parent.status === "TERMINATED" || parent.id === selfId) throw new PartnerRefused("Choose a distributor that exists and is not terminated.");
  const outside = clean.territories.filter((c) => !parent.territories.includes(c));
  if (outside.length) throw new PartnerRefused(`Outside ${parent.displayName}'s territories: ${outside.join(", ")}.`);
  return parent.id;
}

function partnerData(clean: CleanPartner) {
  return {
    slug: clean.slug,
    kind: clean.kind,
    legalName: clean.legalName,
    displayName: clean.displayName,
    country: clean.country,
    territories: clean.territories,
    contactName: clean.contactName,
    contactEmail: clean.contactEmail,
    contactPhone: clean.contactPhone,
    website: clean.website,
    addressLine1: clean.addressLine1,
    addressLine2: clean.addressLine2,
    city: clean.city,
    region: clean.region,
    postalCode: clean.postalCode,
    taxIds: clean.taxIds as Prisma.InputJsonValue,
    publicListing: clean.publicListing,
    publicBlurb: clean.publicBlurb,
  };
}

// ─── Creating ────────────────────────────────────────────────────────────────────────────────────

/**
 * Writes a checked partner and its first terms in one transaction — ONBOARDING, `createdBy` the
 * actor — with its `partner.create` and `terms.set` rows. `within` runs in the same transaction after
 * it is made (a request or an application marking itself decided), so both happen or neither.
 */
export async function createPartnerWith(
  clean: CleanPartner,
  terms: CleanTerms,
  actor: PartnerActor,
  within?: (tx: Prisma.TransactionClient, made: { id: string; slug: string }) => Promise<void>,
): Promise<{ id: string; slug: string }> {
  try {
    return await controlDb().$transaction(async (tx) => {
      if (await tx.partner.findUnique({ where: { slug: clean.slug }, select: { id: true } })) throw new PartnerRefused("That address is taken.");
      const parentId = await parentFor(tx, clean, null);
      const made = await tx.partner.create({ data: { ...partnerData(clean), parentId, status: "ONBOARDING", createdBy: actorRef(actor) }, select: { id: true, slug: true } });
      const row = await writeTerms(tx, made.id, terms, actorRef(actor));
      await partnerAudit(actor, made.id, "partner.create", "partner", made.id, { partner: made.slug, kind: clean.kind }, { tx });
      // The day terms start is India's, as src/lib/partners/terms.ts reads it.
      await partnerAudit(actor, made.id, "terms.set", "terms", row.id, { from: indiaClock.dateKey(row.effectiveFrom) }, { tx });
      if (within) await within(tx, made);
      return made;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PartnerRefused("That address is taken.");
    throw err;
  }
}

/** A new partner with its initial terms (console, MANAGERS). It starts ONBOARDING. */
export async function createPartner(input: PartnerInput, terms: TermsInput, staff: Staff, now: Date = new Date()): Promise<{ id: string; slug: string }> {
  const clean = cleanPartnerInput(input);
  const cleanT = await cleanTerms(terms, { id: null, kind: clean.kind, territories: clean.territories }, now);
  return createPartnerWith(clean, cleanT, staffActor(staff));
}

// ─── Editing ─────────────────────────────────────────────────────────────────────────────────────

const EDIT_SELECT = {
  id: true,
  slug: true,
  kind: true,
  status: true,
  parentId: true,
  parent: { select: { slug: true } },
  legalName: true,
  displayName: true,
  country: true,
  territories: true,
  contactName: true,
  contactEmail: true,
  contactPhone: true,
  website: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  taxIds: true,
  publicListing: true,
  publicBlurb: true,
  notes: true,
} as const satisfies Prisma.PartnerSelect;

type EditRecord = Prisma.PartnerGetPayload<{ select: typeof EDIT_SELECT }>;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function changedFields(clean: CleanPartner, parentId: string | null, current: EditRecord): string[] {
  const data = partnerData(clean);
  const fields: string[] = (Object.keys(data) as (keyof typeof data)[]).filter((k) => !same(data[k], current[k]));
  if (parentId !== current.parentId) fields.push("parent");
  return fields;
}

/**
 * Staff's edit of a partner (console, MANAGERS): any of its details, plus the staff-only notes.
 * Fields left out stay as they are. Returns the slug (after the edit) and which fields changed; the
 * console action writes the platform audit. Notes are staff's: a change to them alone is not shown
 * in the partner's own activity log.
 */
export async function updatePartner(partnerId: string, input: Partial<PartnerInput> & { notes?: string | null }, staff: Staff, now: Date = new Date()): Promise<{ slug: string; changed: string[] }> {
  const id = cleanId(partnerId);
  const current = id ? await controlDb().partner.findUnique({ where: { id }, select: EDIT_SELECT }) : null;
  if (!current) throw new PartnerRefused("That partner no longer exists.");
  const x = (input ?? {}) as Partial<PartnerInput> & { notes?: string | null };
  const kind = x.kind !== undefined ? x.kind : current.kind;
  const given = (k: keyof PartnerInput) => x[k] !== undefined;
  const address = x.address
    ? {
        line1: x.address.line1 !== undefined ? x.address.line1 : current.addressLine1,
        line2: x.address.line2 !== undefined ? x.address.line2 : current.addressLine2,
        city: x.address.city !== undefined ? x.address.city : current.city,
        region: x.address.region !== undefined ? x.address.region : current.region,
        postalCode: x.address.postalCode !== undefined ? x.address.postalCode : current.postalCode,
      }
    : { line1: current.addressLine1, line2: current.addressLine2, city: current.city, region: current.region, postalCode: current.postalCode };
  const clean = cleanPartnerInput({
    slug: given("slug") ? String(x.slug) : current.slug,
    kind,
    // A reseller made a distributor leaves its distributor.
    parentSlug: given("parentSlug") ? x.parentSlug : String(kind).toUpperCase() === "DISTRIBUTOR" ? null : (current.parent?.slug ?? null),
    legalName: given("legalName") ? String(x.legalName) : current.legalName,
    displayName: given("displayName") ? String(x.displayName) : current.displayName,
    country: given("country") ? String(x.country) : current.country,
    territories: given("territories") ? (x.territories as string[]) : current.territories,
    contactName: given("contactName") ? String(x.contactName) : current.contactName,
    contactEmail: given("contactEmail") ? String(x.contactEmail) : current.contactEmail,
    contactPhone: given("contactPhone") ? x.contactPhone : current.contactPhone,
    website: given("website") ? x.website : current.website,
    address,
    taxIds: given("taxIds") ? x.taxIds : (current.taxIds as unknown as { kind: string; value: string }[]),
    publicListing: given("publicListing") ? x.publicListing === true : current.publicListing,
    publicBlurb: given("publicBlurb") ? x.publicBlurb : current.publicBlurb,
  });
  const notes = x.notes !== undefined ? manyLines(x.notes) || null : current.notes;
  if (notes && notes.length > 4000) throw new PartnerRefused("Keep the notes to 4,000 characters.");

  const territoriesChanged = !same(clean.territories, current.territories);
  if (territoriesChanged && clean.kind === "DISTRIBUTOR" && current.status === "ACTIVE") {
    const terms = await termsAt(current.id, now);
    if (terms?.territoryRateBp !== null && terms?.territoryRateBp !== undefined) await assertNoTerritoryOverlap(current.id, clean.territories, now);
  }

  let changed: string[] = [];
  try {
    await controlDb().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM partners WHERE id = ${current.id} FOR UPDATE`;
      if (clean.slug !== current.slug && (await tx.partner.findUnique({ where: { slug: clean.slug }, select: { id: true } }))) throw new PartnerRefused("That address is taken.");
      const resellers = await tx.partner.findMany({ where: { parentId: current.id }, select: { displayName: true, status: true, territories: true } });
      if (clean.kind !== "DISTRIBUTOR" && resellers.length) throw new PartnerRefused("It has resellers. Move them to another distributor first.");
      if (territoriesChanged) {
        for (const r of resellers) {
          if (r.status === "TERMINATED") continue;
          const outside = r.territories.filter((c) => !clean.territories.includes(c));
          if (outside.length) throw new PartnerRefused(`${r.displayName} still sells in ${outside.join(", ")}. Change its territories first.`);
        }
      }
      const parentId = await parentFor(tx, clean, current.id);
      changed = changedFields(clean, parentId, current);
      if (notes !== current.notes) changed.push("notes");
      if (!changed.length) throw new PartnerRefused("Nothing to change.");
      await tx.partner.update({ where: { id: current.id }, data: { ...partnerData(clean), parentId, notes }, select: { id: true } });
      const shown = changed.filter((f) => f !== "notes");
      await partnerAudit(staffActor(staff), current.id, "partner.update", "partner", current.id, { partner: clean.slug, fields: shown.length ? shown : changed }, { tx, visibleToPartner: shown.length > 0 });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new PartnerRefused("That address is taken.");
    throw err;
  }
  return { slug: clean.slug, changed };
}

/** What a partner's own ADMIN may change directly in the portal. */
export type PartnerSelfInput = { displayName?: string; contactPhone?: string | null; website?: string | null; publicBlurb?: string | null; publicListing?: boolean };

/**
 * The portal's direct profile edit (ADMIN only): display name, phone, website, public description
 * and listing. Anything else goes through a PROFILE request. Audited `profile.update`.
 */
export async function updatePartnerSelf(me: PartnerMe, input: PartnerSelfInput): Promise<{ changed: string[] }> {
  if (me.role !== "ADMIN") throw new PartnerRefused("Your role cannot do that.");
  const x = (input ?? {}) as PartnerSelfInput;
  const current = await controlDb().partner.findUnique({
    where: { id: me.partner.id },
    select: { id: true, status: true, displayName: true, contactPhone: true, website: true, publicBlurb: true, publicListing: true },
  });
  if (!current || current.status === "TERMINATED") throw new PartnerRefused("Sign in to the partner portal again.");
  const before: Required<PartnerSelfInput> = current;
  const data: Prisma.PartnerUpdateInput = {};
  const changed: string[] = [];
  const set = <K extends keyof PartnerSelfInput>(key: K, value: Required<PartnerSelfInput>[K]) => {
    if (value === before[key]) return;
    (data as Record<string, unknown>)[key] = value;
    changed.push(key);
  };
  if (x.displayName !== undefined) set("displayName", cleanDisplayName(x.displayName));
  if (x.contactPhone !== undefined) set("contactPhone", cleanPhone(x.contactPhone));
  if (x.website !== undefined) set("website", cleanWebsite(x.website));
  if (x.publicBlurb !== undefined) set("publicBlurb", cleanBlurb(x.publicBlurb));
  if (x.publicListing !== undefined) set("publicListing", x.publicListing === true);
  if (!changed.length) throw new PartnerRefused("Nothing to change.");
  await controlDb().$transaction(async (tx) => {
    await tx.partner.update({ where: { id: current.id }, data, select: { id: true } });
    await partnerAudit(meActor(me), current.id, "profile.update", "partner", current.id, { fields: changed }, { tx });
  });
  return { changed };
}

// ─── Status ──────────────────────────────────────────────────────────────────────────────────────

const STATUS_MAIL: Record<Exclude<PartnerStatus, "ONBOARDING">, { subject: string; lines: string[] }> = {
  ACTIVE: {
    subject: "Partner portal: your partner account is now active",
    lines: ["Your partner account is now active. You can create invitation codes, referral links and deal registrations in the partner portal."],
  },
  SUSPENDED: {
    subject: "Partner portal: your partner account has been suspended",
    lines: ["Your partner account has been suspended. Your customers and commissions are unaffected; new codes, links and registrations are paused.", "", "Contact your partner manager."],
  },
  TERMINATED: {
    subject: "Partner portal: your partner account has been terminated",
    lines: [
      "Your partner account has been terminated, and signing in to the partner portal has ended.",
      "",
      "Commission already earned is still paid on your statements. Contact your partner manager with any questions.",
    ],
  },
};

const ALLOWED: Record<PartnerStatus, PartnerStatus[]> = {
  ONBOARDING: ["ACTIVE", "TERMINATED"],
  ACTIVE: ["SUSPENDED", "TERMINATED"],
  SUSPENDED: ["ACTIVE", "TERMINATED"],
  TERMINATED: [],
};

const STATUS_WORDS: Record<PartnerStatus, string> = { ONBOARDING: "onboarding", ACTIVE: "active", SUSPENDED: "suspended", TERMINATED: "terminated" };

/** What a termination ended. */
export type TerminationCounts = { sessions: number; invites: number; links: number; deals: number; requests: number };

/**
 * A partner's status (console, MANAGERS; reason 3–500 characters, staff's own — never shown in the
 * portal). Every change is audited `partner.status` on the partner (visible) and emailed to its
 * ADMIN users; the console action writes the platform audit.
 */
export async function setPartnerStatus(
  partnerId: string,
  statusInput: PartnerStatus,
  reasonInput: string,
  staff: Staff,
  now: Date = new Date(),
): Promise<{ slug: string; from: PartnerStatus; to: PartnerStatus; ended: TerminationCounts | null }> {
  const to = String(statusInput ?? "").toUpperCase() as PartnerStatus;
  if (!(Object.keys(ALLOWED) as string[]).includes(to)) throw new PartnerRefused("Choose onboarding, active, suspended or terminated.");
  const reason = requiredText(reasonInput, 3, 500, "Give a reason (3 to 500 characters).");
  const id = cleanId(partnerId);
  const actor = staffActor(staff);

  const result = await controlDb().$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM partners WHERE id = ${id} FOR UPDATE`;
    if (!locked[0]) throw new PartnerRefused("That partner no longer exists.");
    const partner = await tx.partner.findUniqueOrThrow({ where: { id }, select: { id: true, slug: true, status: true, activatedAt: true } });
    const from = partner.status;
    if (from === to) throw new PartnerRefused(`It is ${STATUS_WORDS[to]} already.`);
    if (from === "TERMINATED") throw new PartnerRefused("A terminated partner stays terminated.");
    if (!ALLOWED[from].includes(to)) throw new PartnerRefused(`A partner can't go from ${STATUS_WORDS[from]} to ${STATUS_WORDS[to]}.`);

    let ended: TerminationCounts | null = null;
    const data: Prisma.PartnerUpdateInput = { status: to, statusReason: reason };
    if (to === "ACTIVE") {
      if (from === "ONBOARDING") {
        const terms = await tx.partnerTerms.count({ where: { partnerId: id, effectiveFrom: { lte: now } } });
        if (!terms) throw new PartnerRefused("It has no commission terms in force. Set its terms first.");
        const admins = await tx.partnerUser.count({ where: { partnerId: id, role: "ADMIN", active: true } });
        if (!admins) throw new PartnerRefused("It has no active admin. Invite its first admin first.");
      }
      if (!partner.activatedAt) data.activatedAt = now;
      data.suspendedAt = null;
    } else if (to === "SUSPENDED") {
      data.suspendedAt = now;
    } else if (to === "TERMINATED") {
      const resellers = await tx.partner.count({ where: { parentId: id, status: { not: "TERMINATED" } } });
      if (resellers) throw new PartnerRefused("Move or terminate its resellers first.");
      data.terminatedAt = now;
      const by = actorRef(actor);
      const sessions = await revokePartnerSessions(id, tx);
      // Live codes end now; used-up and expired ones keep the end they had.
      const invites = await tx.$executeRaw`
        UPDATE "signup_invites" SET "expiresAt" = ${now}
        WHERE "partnerId" = ${id} AND "uses" < "maxUses" AND ("expiresAt" IS NULL OR "expiresAt" > ${now})`;
      const links = await tx.partnerReferralLink.updateMany({ where: { partnerId: id, endedAt: null }, data: { endedAt: now } });
      const pendingDeals = await tx.dealRegistration.updateMany({ where: { partnerId: id, status: "PENDING" }, data: { status: "WITHDRAWN", decisionNote: "Partner terminated", decidedAt: now, decidedBy: by } });
      // An approved registration would keep its domain from every other partner until it expired.
      const approvedDeals = await tx.dealRegistration.updateMany({ where: { partnerId: id, status: "APPROVED" }, data: { status: "WITHDRAWN" } });
      const requests = await tx.partnerRequest.updateMany({ where: { partnerId: id, status: "PENDING" }, data: { status: "WITHDRAWN", decisionNote: "Partner terminated", decidedAt: now, decidedBy: by, payloadCipher: null } });
      ended = { sessions, invites, links: links.count, deals: pendingDeals.count + approvedDeals.count, requests: requests.count };
    }
    await tx.partner.update({ where: { id }, data, select: { id: true } });
    await partnerAudit(actor, id, "partner.status", "partner", id, { partner: partner.slug, from, to, ...(ended ? { ended } : {}) }, { tx });
    return { slug: partner.slug, from, to, ended };
  });

  if (to !== "ONBOARDING") {
    const mail = STATUS_MAIL[to];
    await mailPartnerUsers(id, { roles: ["ADMIN"] }, mail.subject, mail.lines);
  }
  return result;
}

// ─── Lookups ─────────────────────────────────────────────────────────────────────────────────────

/** A partner's id from its console address, or null. */
export async function partnerIdBySlug(slug: string): Promise<string | null> {
  const key = String(slug ?? "").trim().toLowerCase();
  if (!SLUG.test(key)) return null;
  const row = await controlDb().partner.findUnique({ where: { slug: key }, select: { id: true } });
  return row?.id ?? null;
}

/** One partner on the public "Find a partner" page — nothing else about it is public. */
export type PublicPartner = { displayName: string; kind: PartnerKind; territories: string[]; publicBlurb: string | null; website: string | null };

/**
 * The public directory: ACTIVE partners that chose to be listed, by name — optionally only those
 * selling in `country` — and the countries any listed partner sells in (for the filter), by name.
 */
export async function publicPartnerDirectory(country?: string | null): Promise<{ countries: { code: string; name: string }[]; partners: PublicPartner[] }> {
  const rows = await controlDb().partner.findMany({
    where: { status: "ACTIVE", publicListing: true },
    orderBy: [{ displayName: "asc" }, { slug: "asc" }],
    take: 500,
    select: { displayName: true, kind: true, territories: true, publicBlurb: true, website: true },
  });
  const codes = new Set(rows.flatMap((r) => r.territories));
  const countries = [...codes]
    .filter((c) => COUNTRY_NAMES.has(c))
    .map((code) => ({ code, name: COUNTRY_NAMES.get(code)! }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const wanted = String(country ?? "").trim().toUpperCase();
  const partners = COUNTRY_CODES.has(wanted) ? rows.filter((r) => r.territories.includes(wanted)) : rows;
  return { countries, partners };
}
