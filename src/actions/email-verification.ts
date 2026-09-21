"use server";

import { revalidatePath } from "next/cache";
import type { EmailCheckMethod, EmailCheckStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { parseEmailAddress } from "@/lib/email-verification";
import { checkEmailAddress, primeMailHosts } from "@/lib/email-verification-lookup";
import type { ActionResult } from "@/actions/company";

/**
 * Standing an email address up before anyone spends a morning writing to it.
 *
 * Nothing here ever edits the address. A check writes a verdict beside it, and the verdict is
 * stamped with the exact string it was run against — see `emailCheckState` for why that matters.
 */

type CheckResult = {
  contactId: string;
  status: EmailCheckStatus;
  detail: string;
};

/**
 * Feeds the DNS cache from what Domain Intel already found, so checking a company's contacts
 * usually costs no lookups at all. The profile is only trusted for its own domain, and only while
 * it is recent enough that mail routing is unlikely to have moved.
 */
const PROFILE_FRESH_MS = 30 * 24 * 60 * 60 * 1000;

async function primeFromDomainProfiles(companyIds: string[]) {
  if (companyIds.length === 0) return;
  const profiles = await db.domainProfile.findMany({
    where: { companyId: { in: companyIds }, fetchedAt: { not: null } },
    select: { domain: true, mxHosts: true, fetchedAt: true },
  });
  for (const p of profiles) {
    if (!p.fetchedAt || Date.now() - p.fetchedAt.getTime() > PROFILE_FRESH_MS) continue;
    primeMailHosts(p.domain.toLowerCase(), p.mxHosts);
  }
}

async function writeResult(
  contactId: string,
  email: string,
  outcome: { status: EmailCheckStatus; detail: string },
  method: EmailCheckMethod,
  userId: string,
) {
  await db.contact.update({
    where: { id: contactId },
    data: {
      emailStatus: outcome.status,
      emailCheckDetail: outcome.detail,
      emailCheckMethod: method,
      emailCheckedValue: email,
      emailCheckedAt: new Date(),
      emailCheckedByUserId: userId,
    },
  });
}

/** Checks one address. */
export async function verifyContactEmail(contactId: string): Promise<ActionResult<CheckResult>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { id: true, name: true, email: true, companyId: true, company: { select: { name: true } } },
  });
  if (!contact) return { ok: false, error: "That contact no longer exists." };
  if (!contact.email) return { ok: false, error: "There's no email address on this contact to check." };

  await primeFromDomainProfiles([contact.companyId]);
  const outcome = await checkEmailAddress(contact.email);
  await writeResult(contact.id, contact.email, outcome, "AUTOMATIC", user.id);

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: contact.id,
    entityLabel: `Checked ${contact.email} — ${outcome.status.toLowerCase()}`,
  });
  revalidatePath(`/companies/${contact.companyId}`);
  revalidatePath("/contacts");
  return { ok: true, data: { contactId: contact.id, status: outcome.status, detail: outcome.detail } };
}

/**
 * Checks a batch — a company's contacts, or a selection on the contacts list.
 *
 * Domains repeat heavily in any real batch, and the resolver cache means one query serves them all;
 * the work is still done in series rather than all at once, because firing two hundred parallel DNS
 * queries at a public resolver is the kind of thing that gets rate-limited.
 */
export async function verifyContactEmails(contactIds: string[]): Promise<
  ActionResult<{ checked: number; skipped: number; results: CheckResult[] }>
> {
  const user = await requireUser();
  if (contactIds.length === 0) return { ok: false, error: "Nothing selected." };

  const contacts = await db.contact.findMany({
    where: { id: { in: contactIds } },
    select: { id: true, email: true, companyId: true },
  });

  await primeFromDomainProfiles([...new Set(contacts.map((c) => c.companyId))]);

  const results: CheckResult[] = [];
  let skipped = 0;
  for (const contact of contacts) {
    if (!contact.email) {
      skipped += 1;
      continue;
    }
    const outcome = await checkEmailAddress(contact.email);
    await writeResult(contact.id, contact.email, outcome, "AUTOMATIC", user.id);
    results.push({ contactId: contact.id, status: outcome.status, detail: outcome.detail });
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: contacts[0]?.id ?? "batch",
    entityLabel: `Checked ${results.length} email address(es)`,
  });
  for (const companyId of new Set(contacts.map((c) => c.companyId))) revalidatePath(`/companies/${companyId}`);
  revalidatePath("/contacts");
  return { ok: true, data: { checked: results.length, skipped, results } };
}

/** Every unchecked address at one company, in one press. */
export async function verifyCompanyEmails(companyId: string): Promise<
  ActionResult<{ checked: number; skipped: number; results: CheckResult[] }>
> {
  await requireUser();
  const contacts = await db.contact.findMany({
    where: { companyId, email: { not: null } },
    select: { id: true },
  });
  if (contacts.length === 0) return { ok: false, error: "No contacts here have an email address." };
  return verifyContactEmails(contacts.map((c) => c.id));
}

/**
 * A person's own verdict, which outranks the machine's.
 *
 * DNS can only ever say the domain accepts mail. Someone who got a reply, or who was told on a call
 * that the address is right, knows something no lookup can establish — so their answer is stored
 * with its own method and is not overwritten by a later automatic check unless someone asks for one.
 */
export async function markEmailConfirmed(
  contactId: string,
  verdict: "CONFIRMED" | "WRONG",
  note?: string,
): Promise<ActionResult<CheckResult>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { id: true, email: true, companyId: true },
  });
  if (!contact) return { ok: false, error: "That contact no longer exists." };
  if (!contact.email) return { ok: false, error: "There's no email address on this contact." };

  const status: EmailCheckStatus = verdict === "CONFIRMED" ? "VALID" : "INVALID";
  const detail =
    note?.trim() ||
    (verdict === "CONFIRMED"
      ? `${user.name} confirmed this address reaches them.`
      : `${user.name} reported this address as wrong.`);

  await writeResult(
    contact.id,
    contact.email,
    { status, detail },
    verdict === "CONFIRMED" ? "CONFIRMED" : "REPORTED",
    user.id,
  );

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: contact.id,
    entityLabel: `${verdict === "CONFIRMED" ? "Confirmed" : "Reported wrong"}: ${contact.email}`,
  });
  revalidatePath(`/companies/${contact.companyId}`);
  revalidatePath("/contacts");
  return { ok: true, data: { contactId: contact.id, status, detail } };
}

/**
 * A verdict only counts while it still describes the address on file.
 *
 * The badge already works this out per row by comparing the two strings; the counters have to
 * agree with it, or the page says "1 verified" next to a contact showing no tick. Prisma's field
 * reference puts that same comparison in the query rather than pulling every contact back to do it
 * in memory.
 */
const CURRENT: Prisma.ContactWhereInput = {
  email: { not: null },
  emailCheckedValue: { equals: db.contact.fields.email },
};

/** How the address book looks at a glance. */
export async function emailVerificationSummary() {
  await requireUser();
  const [total, checked, valid, risky, invalid] = await Promise.all([
    db.contact.count({ where: { email: { not: null } } }),
    db.contact.count({ where: CURRENT }),
    db.contact.count({ where: { ...CURRENT, emailStatus: "VALID" } }),
    db.contact.count({ where: { ...CURRENT, emailStatus: "RISKY" } }),
    db.contact.count({ where: { ...CURRENT, emailStatus: "INVALID" } }),
  ]);
  // Anything whose address has moved on since it was checked is unchecked again, which is the
  // same rule the badge applies.
  return { total, unchecked: total - checked, valid, risky, invalid };
}

/** Addresses the last check condemned, so somebody can go and find the right ones. */
export async function badEmailContacts(params: { page: number; pageSize: number }) {
  await requireUser();
  const where: Prisma.ContactWhereInput = { ...CURRENT, emailStatus: { in: ["INVALID", "RISKY"] } };
  const [rows, total] = await Promise.all([
    db.contact.findMany({
      where,
      orderBy: [{ emailStatus: "asc" }, { emailCheckedAt: "desc" }],
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: {
        id: true, name: true, designation: true, email: true, phone: true,
        emailStatus: true, emailCheckedValue: true, emailCheckedAt: true,
        emailCheckMethod: true, emailCheckDetail: true,
        company: { select: { id: true, name: true } },
      },
    }),
    db.contact.count({ where }),
  ]);
  return toPlain({ rows, total });
}

/** Used by the import and the contact form to warn before anything is saved. */
export async function previewEmailCheck(email: string): Promise<CheckResult & { email: string }> {
  await requireUser();
  const parsed = parseEmailAddress(email);
  if (!parsed) {
    return { contactId: "", email, status: "INVALID", detail: "Not a valid email address." };
  }
  const outcome = await checkEmailAddress(email);
  return { contactId: "", email, status: outcome.status, detail: outcome.detail };
}
