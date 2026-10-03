import Papa from "papaparse";
import type { ContactDesignation, MarketingTopic } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCompanyName } from "@/lib/company-name";
import { isFreeMailbox, parseEmailAddress } from "@/lib/email-verification";
import { checkEmailAddress } from "@/lib/email-verification-lookup";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * An uploaded list of people for a mass mail.
 *
 * Every row becomes — or is matched to — a contact first. That is the whole point: an unsubscribe
 * is recorded against the person, so it holds for the next campaign and the one after, and the
 * same suppression rules that protect CRM contacts protect these. Nobody is mailed straight from a
 * spreadsheet.
 *
 * Where a row's company comes from, in order: the company column, matched to a company we have or
 * created; the email's domain, matched through a colleague already on file or created under the
 * domain's name; and for a gmail or yahoo address with no company, one shared "Individuals" record
 * rather than a company per person.
 *
 * Consent is recorded for the topics the uploader named, with their note as the evidence — but only
 * where none exists. Somebody who unsubscribed stays unsubscribed, whatever list they turn up on.
 */

export const MAX_LIST_ROWS = 5000;
export const INDIVIDUALS_COMPANY = "Individuals (mailing lists)";

export type ListRow = { email: string; name: string | null; company: string | null; phone: string | null; designation: string | null; line: number };

export type ParsedList = {
  rows: ListRow[];
  invalid: { line: number; value: string }[];
  duplicates: number;
  columns: { email: string | null; name: string | null; company: string | null; phone: string | null; designation: string | null };
  tooMany: boolean;
};

const COLUMN_NAMES: Record<keyof ParsedList["columns"], RegExp> = {
  email: /^(e-?mail|email ?address|e-?mail id|mail)$/i,
  name: /^(name|full ?name|contact ?name|person)$/i,
  company: /^(company|company ?name|organi[sz]ation|organi[sz]ation ?name|business|firm|account)$/i,
  phone: /^(phone|mobile|phone ?number|mobile ?number|contact ?number|whatsapp)$/i,
  designation: /^(designation|title|job ?title|role|position)$/i,
};

/** Reads the CSV and says what it found — nothing is written. */
export function parseListCsv(text: string): ParsedList {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  const headers = parsed.meta.fields ?? [];
  const find = (key: keyof ParsedList["columns"]) => headers.find((h) => COLUMN_NAMES[key].test(h)) ?? null;
  const columns = { email: find("email"), name: find("name"), company: find("company"), phone: find("phone"), designation: find("designation") };
  // "First name" and "Last name" are joined when there's no single name column.
  const first = headers.find((h) => /^first ?name$/i.test(h)) ?? null;
  const last = headers.find((h) => /^(last ?name|surname)$/i.test(h)) ?? null;

  const rows: ListRow[] = [];
  const invalid: ParsedList["invalid"] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  const cell = (r: Record<string, string>, col: string | null) => (col ? (r[col] ?? "").trim() || null : null);

  parsed.data.forEach((raw, i) => {
    const line = i + 2; // the header is line 1
    const value = cell(raw, columns.email) ?? "";
    const address = parseEmailAddress(value);
    if (!address) {
      if (value || Object.values(raw).some((v) => v?.trim())) invalid.push({ line, value });
      return;
    }
    const email = `${address.local}@${address.domain}`.toLowerCase();
    if (seen.has(email)) {
      duplicates += 1;
      return;
    }
    seen.add(email);
    const name = cell(raw, columns.name) ?? ([cell(raw, first), cell(raw, last)].filter(Boolean).join(" ") || null);
    rows.push({ email, name, company: cell(raw, columns.company), phone: cell(raw, columns.phone), designation: cell(raw, columns.designation), line });
  });

  return { rows: rows.slice(0, MAX_LIST_ROWS), invalid, duplicates, columns, tooMany: rows.length > MAX_LIST_ROWS };
}

/** A job title as typed, onto the few the CRM records. Anything unrecognised is Other. */
export function designationFrom(title: string | null): ContactDesignation {
  const t = (title ?? "").toLowerCase();
  if (/\bcio\b|chief information/.test(t)) return "CIO";
  if (/\bceo\b|chief executive|founder/.test(t)) return "CEO";
  if (/\bcto\b|chief tech|head of it|it head|head it|head - it/.test(t)) return "IT_HEAD";
  if (/director|\bmd\b|managing|partner|owner|proprietor/.test(t)) return "DIRECTOR";
  if (/purchase|procure|buyer|sourcing/.test(t)) return "PURCHASE_MANAGER";
  if (/\bit\b|system|network|infra|admin/.test(t)) return "IT_MANAGER";
  if (/\bhr\b|human resource|people|talent/.test(t)) return "HR";
  return "OTHER";
}

/** A domain as a company name: "sales.acme.co.in" → "acme.co.in". Good enough to be found and renamed. */
export function companyNameFromDomain(domain: string): string {
  const parts = domain.toLowerCase().split(".");
  const secondLevel = parts.length >= 3 && /^(co|com|net|org|gov|ac|edu|res|gen|firm|ind)$/.test(parts[parts.length - 2]!);
  return parts.slice(secondLevel ? -3 : -2).join(".");
}

export type ImportSummary = {
  listId: string;
  rows: number;
  invalid: number;
  duplicates: number;
  tooMany: boolean;
  matchedContacts: number;
  createdContacts: number;
  createdCompanies: number;
  consentRecorded: number;
  /** On the list, but they had already unsubscribed — they stay unsubscribed. */
  alreadyUnsubscribed: number;
  checked: { valid: number; risky: number; invalid: number; unknown: number };
};

/**
 * Imports the list. `ownerUserId` becomes the account manager of any company this creates — the
 * person who brought these people in.
 */
export async function importMarketingList(input: {
  userId: string;
  name: string;
  fileName: string | null;
  csvText: string;
  consentNote: string;
  topics: MarketingTopic[];
}): Promise<{ ok: true; data: ImportSummary } | { ok: false; error: string }> {
  const parsed = parseListCsv(input.csvText);
  if (!parsed.columns.email) return { ok: false, error: "No email column — the first row should name the columns, one of them Email." };
  if (parsed.rows.length === 0) return { ok: false, error: "No valid email addresses in that file." };

  // ── Contacts already on file, by address, whatever case it was typed in ────────────────
  const emails = parsed.rows.map((r) => r.email);
  const existing = await db.$queryRaw<{ id: string; email: string }[]>`
    SELECT id, lower(email) AS email FROM contacts WHERE lower(email) = ANY(${emails}::text[])`;
  const contactByEmail = new Map(existing.map((c) => [c.email, c.id]));
  const fresh = parsed.rows.filter((r) => !contactByEmail.has(r.email));

  // ── Companies for the new ones ──────────────────────────────────────────────────────────
  const companyFor = new Map<string, string>(); // row email → company id
  let createdCompanies = 0;

  // A colleague already on file tells us the company for a domain better than the domain's name does.
  const domains = [...new Set(fresh.filter((r) => !r.company && !isFreeMailbox(r.email.split("@")[1]!)).map((r) => r.email.split("@")[1]!))];
  const colleagues = domains.length
    ? await db.$queryRaw<{ domain: string; companyId: string }[]>`
        SELECT DISTINCT ON (split_part(lower(email), '@', 2)) split_part(lower(email), '@', 2) AS domain, "companyId"
          FROM contacts WHERE split_part(lower(email), '@', 2) = ANY(${domains}::text[])`
    : [];
  const companyByDomain = new Map(colleagues.map((c) => [c.domain, c.companyId]));

  // Names only for the rows no colleague answers for — a company made for nobody is clutter.
  const byName = new Map<string, string>(); // normalised name → display name
  for (const r of fresh) {
    const domain = r.email.split("@")[1]!;
    if (!r.company && companyByDomain.has(domain)) continue;
    const name = r.company ?? (isFreeMailbox(domain) ? INDIVIDUALS_COMPANY : companyNameFromDomain(domain));
    byName.set(normalizeCompanyName(name), name);
  }

  const known = await db.company.findMany({ where: { normalizedName: { in: [...byName.keys()] } }, select: { id: true, normalizedName: true } });
  const companyByName = new Map(known.map((c) => [c.normalizedName, c.id]));
  const toCreate = [...byName.entries()].filter(([norm]) => !companyByName.has(norm));
  if (toCreate.length) {
    const created = await db.company.createManyAndReturn({
      data: toCreate.map(([normalizedName, name]) => ({
        name,
        normalizedName,
        relationshipType: "CLIENT" as const,
        stage: "PROSPECT" as const,
        source: "OTHER" as const,
        createdById: input.userId,
        ownerUserId: input.userId,
      })),
      skipDuplicates: true,
      select: { id: true, normalizedName: true },
    });
    createdCompanies = created.length;
    for (const c of created) companyByName.set(c.normalizedName, c.id);
    // Anything skipped as a duplicate was created by somebody else a moment ago — look it up.
    const stillMissing = toCreate.map(([n]) => n).filter((n) => !companyByName.has(n));
    if (stillMissing.length) {
      for (const c of await db.company.findMany({ where: { normalizedName: { in: stillMissing } }, select: { id: true, normalizedName: true } })) companyByName.set(c.normalizedName, c.id);
    }
  }
  for (const r of fresh) {
    const domain = r.email.split("@")[1]!;
    const viaColleague = !r.company ? companyByDomain.get(domain) : undefined;
    const name = r.company ?? (isFreeMailbox(domain) ? INDIVIDUALS_COMPANY : companyNameFromDomain(domain));
    companyFor.set(r.email, viaColleague ?? companyByName.get(normalizeCompanyName(name))!);
  }

  // ── The new contacts ────────────────────────────────────────────────────────────────────
  const createdContacts = fresh.length
    ? await db.contact.createManyAndReturn({
        data: fresh.map((r) => ({
          companyId: companyFor.get(r.email)!,
          name: r.name ?? r.email.split("@")[0]!,
          email: r.email,
          phone: r.phone,
          designation: designationFrom(r.designation),
          isPrimary: false,
        })),
        select: { id: true, email: true },
      })
    : [];
  for (const c of createdContacts) contactByEmail.set(c.email!.toLowerCase(), c.id);
  const contactIds = parsed.rows.map((r) => contactByEmail.get(r.email)).filter((id): id is string => !!id);

  // ── The list, and the consent it carries ───────────────────────────────────────────────
  // The day on the workspace's calendar, not UTC's.
  const today = (await workspaceClock()).today();
  const list = await db.marketingList.create({
    data: {
      name: input.name,
      fileName: input.fileName,
      consentNote: input.consentNote,
      topics: input.topics,
      createdById: input.userId,
      members: { createMany: { data: contactIds.map((contactId) => ({ contactId })), skipDuplicates: true } },
    },
    select: { id: true },
  });
  // Only where there is no row: an UNSUBSCRIBED row is left exactly as it is.
  const consent = await db.contactConsent.createMany({
    data: contactIds.flatMap((contactId) =>
      input.topics.map((topic) => ({
        contactId,
        channel: "EMAIL" as const,
        topic,
        status: "SUBSCRIBED" as const,
        source: "IMPORT" as const,
        evidence: `On the list "${input.name}"${input.fileName ? ` (${input.fileName})` : ""}, uploaded ${today}: ${input.consentNote}`.slice(0, 1000),
        capturedById: input.userId,
      })),
    ),
    skipDuplicates: true,
  });
  const alreadyUnsubscribed = await db.contactConsent.count({
    where: { contactId: { in: contactIds }, channel: "EMAIL", topic: { in: input.topics }, status: "UNSUBSCRIBED" },
  });

  // ── Addresses nobody has checked: check them now, so the send can trust them ──────────────
  const unchecked = await db.contact.findMany({
    where: { id: { in: contactIds }, email: { not: null } },
    select: { id: true, email: true, emailCheckedValue: true },
  });
  const toCheck = unchecked.filter((c) => c.email && c.emailCheckedValue !== c.email);
  const checked = { valid: 0, risky: 0, invalid: 0, unknown: 0 };
  const queue = [...toCheck];
  // A few at a time: each is a DNS lookup, and one slow domain shouldn't hold up the rest.
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        const outcome = await checkEmailAddress(c.email);
        await db.contact.update({
          where: { id: c.id },
          data: {
            emailStatus: outcome.status,
            emailCheckDetail: outcome.detail,
            emailCheckMethod: "AUTOMATIC",
            emailCheckedValue: c.email,
            emailCheckedAt: new Date(),
            emailCheckedByUserId: input.userId,
          },
        });
        const key = outcome.status === "VALID" ? "valid" : outcome.status === "RISKY" ? "risky" : outcome.status === "INVALID" ? "invalid" : "unknown";
        checked[key] += 1;
      }
    }),
  );

  return {
    ok: true,
    data: {
      listId: list.id,
      rows: parsed.rows.length,
      invalid: parsed.invalid.length,
      duplicates: parsed.duplicates,
      tooMany: parsed.tooMany,
      matchedContacts: existing.length,
      createdContacts: createdContacts.length,
      createdCompanies,
      consentRecorded: consent.count,
      alreadyUnsubscribed,
      checked,
    },
  };
}
