"use server";

import { revalidatePath } from "next/cache";
import type { Prisma, VerifiedField, VerificationStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canViewContacts, mayWorkWithContactsOf } from "@/lib/authz/contact-access";
import { viaCompanyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { looksLikeEmail } from "@/lib/email-verification";
import type { ActionResult } from "@/actions/company";

/**
 * Records what a caller found out about a contact's email or phone — without changing it.
 *
 * A correction given on a call is a claim, not a fact: people mishear digits, reach the wrong
 * person, or "fix" a number that was right for a different branch. Writing it straight onto the
 * contact would quietly destroy the value the rest of the business has been using, with no way back
 * and no way to tell who changed it. So both values are kept, and accepting a correction is a
 * separate, deliberate act.
 */
export async function verifyContactDetail(input: {
  companyId: string;
  contactId?: string;
  recordId?: string;
  field: VerifiedField;
  originalValue: string;
  status: VerificationStatus;
  correctedValue?: string;
  note?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();

  const corrected = input.correctedValue?.trim();
  if (input.status === "CORRECTED" && !corrected) {
    return { ok: false, error: "Enter the correct value, or mark it simply wrong if you don't have one." };
  }
  // Caught here rather than at review: a reviewer looking at "rohan@acme" three days later has no
  // way to recover the missing part, but the caller still has the person on the phone.
  if (input.status === "CORRECTED" && input.field === "EMAIL" && !looksLikeEmail(corrected)) {
    return { ok: false, error: `"${corrected}" isn't a complete email address — read it back and check the domain.` };
  }

  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true } });
  /**
   * The caller's own account book, or a calling-list record handed to them for this company. The
   * second matters: a campaign is built from its creator's scope and shared out to callers who
   * manage none of those accounts, and the calling station is exactly where this is pressed.
   */
  const viaOwnRecord =
    !!input.recordId &&
    (await canViewContacts(user.id)) &&
    (await db.workbookRecord.count({ where: { id: input.recordId, companyId: input.companyId, assignedToUserId: user.id } })) > 0;
  if (!company || !(viaOwnRecord || (await mayWorkWithContactsOf(user.id, company.id)))) {
    return { ok: false, error: "That company no longer exists." };
  }
  // The contact has to be at that company, or a verdict filed against one account lands on another's contact.
  if (input.contactId) {
    const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== company.id) return { ok: false, error: "That contact isn't at this company." };
  }

  const verification = await db.contactVerification.create({
    data: {
      companyId: company.id,
      contactId: input.contactId || null,
      recordId: input.recordId || null,
      field: input.field,
      originalValue: input.originalValue,
      status: input.status,
      correctedValue: input.status === "CORRECTED" ? corrected! : null,
      note: input.note?.trim() || null,
      verifiedByUserId: user.id,
    },
    select: { id: true },
  });

  // A caller's verdict on an email is worth more than any DNS lookup — they either reached the
  // person or they didn't. Recording it on the contact is not the same as editing the address:
  // the address itself is untouched, and a correction still waits for review below.
  if (input.field === "EMAIL" && input.contactId) {
    await db.contact.update({
      where: { id: input.contactId },
      data: {
        emailStatus: input.status === "CORRECT" ? "VALID" : "INVALID",
        emailCheckMethod: input.status === "CORRECT" ? "CONFIRMED" : "REPORTED",
        emailCheckDetail:
          input.status === "CORRECT"
            ? `${user.name} confirmed this address on a call.`
            : input.status === "CORRECTED"
              ? `${user.name} was given a different address on a call — waiting for review.`
              : `${user.name} was told this address is wrong.`,
        emailCheckedValue: input.originalValue,
        emailCheckedAt: new Date(),
        emailCheckedByUserId: user.id,
      },
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "ContactVerification",
    entityId: verification.id,
    entityLabel: `${input.field.toLowerCase()} marked ${input.status.toLowerCase()} for ${company.name}`,
  });
  revalidatePath(`/companies/${company.id}`);
  revalidatePath("/contacts");
  revalidatePath("/verifications");
  return { ok: true, data: verification };
}

/**
 * Accepts a correction onto the contact — the one place a verification changes real data.
 *
 * The old value stays on the verification row, so the change is reversible by reading it back and
 * is attributable to whoever pressed this rather than to whoever was on the phone.
 */
export async function applyVerification(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const verification = await db.contactVerification.findUnique({
    where: { id },
    select: {
      id: true, field: true, status: true, correctedValue: true, appliedAt: true,
      contactId: true, company: { select: { id: true, name: true } },
    },
  });
  if (!verification || !(await mayWorkWithContactsOf(user.id, verification.company.id))) {
    return { ok: false, error: "That verification no longer exists." };
  }
  if (verification.appliedAt) return { ok: false, error: "That correction has already been applied." };
  if (verification.status !== "CORRECTED" || !verification.correctedValue) {
    return { ok: false, error: "There's no corrected value on this one to apply." };
  }
  if (!verification.contactId) {
    return { ok: false, error: "This was logged against the company rather than a contact, so there's nothing to update." };
  }

  // An address someone at the company read out and a reviewer then accepted is as well-sourced as
  // an address gets — better than any DNS check, which can only ever vouch for the domain. So the
  // new value arrives already confirmed rather than as another unchecked address to chase.
  const emailFields =
    verification.field === "EMAIL"
      ? {
          email: verification.correctedValue,
          emailStatus: "VALID" as const,
          emailCheckMethod: "CONFIRMED" as const,
          emailCheckDetail: "Given on a call and accepted here.",
          emailCheckedValue: verification.correctedValue,
          emailCheckedAt: new Date(),
          emailCheckedByUserId: user.id,
        }
      : { phone: verification.correctedValue };

  const contactId = verification.contactId;
  await db.$transaction(async (tx) => {
    await tx.contact.update({ where: { id: contactId }, data: emailFields });
    await tx.contactVerification.update({
      where: { id },
      data: { appliedAt: new Date(), appliedByUserId: user.id },
    });
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: verification.contactId,
    entityLabel: `Applied verified ${verification.field.toLowerCase()} for ${verification.company.name}`,
  });
  revalidatePath(`/companies/${verification.company.id}`);
  revalidatePath("/verifications");
  return { ok: true, data: null };
}

/** Dismisses a correction without applying it — wrong claims need closing too. */
export async function dismissVerification(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const verification = await db.contactVerification.findUnique({ where: { id }, select: { id: true, appliedAt: true, companyId: true } });
  if (!verification || !(await mayWorkWithContactsOf(user.id, verification.companyId))) {
    return { ok: false, error: "That verification no longer exists." };
  }
  if (verification.appliedAt) return { ok: false, error: "That one has already been applied." };

  // Marked applied-by with no data change: the row stays as the record that somebody looked at it
  // and decided against, which is more useful than deleting the evidence.
  await db.contactVerification.update({
    where: { id },
    data: { appliedAt: new Date(), appliedByUserId: user.id, status: "WRONG", correctedValue: null },
  });
  revalidatePath("/verifications");
  return { ok: true, data: null };
}

/**
 * The verifications this person may see: those on accounts in their scope, and none at all without
 * `contacts.view`. The queue used to list every account's corrections to anybody.
 */
async function verificationScope(userId: string): Promise<Prisma.ContactVerificationWhereInput> {
  if (!(await canViewContacts(userId))) return { id: { in: [] } };
  return (await viaCompanyScope(userId)) as Prisma.ContactVerificationWhereInput;
}

const verificationSelect = {
  id: true,
  field: true,
  originalValue: true,
  correctedValue: true,
  status: true,
  note: true,
  verifiedAt: true,
  appliedAt: true,
  company: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true, email: true, phone: true } },
  verifiedBy: { select: { name: true } },
  appliedBy: { select: { name: true } },
};

/** Corrections waiting for somebody to accept or reject them. */
export async function pendingVerifications(params: { page: number; pageSize: number; onlyCorrections?: boolean }) {
  const user = await requireUser();
  const where: Prisma.ContactVerificationWhereInput = {
    AND: [await verificationScope(user.id), { appliedAt: null, ...(params.onlyCorrections ? { status: "CORRECTED" as const } : {}) }],
  };
  const [rows, total] = await Promise.all([
    db.contactVerification.findMany({
      where,
      orderBy: { verifiedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: verificationSelect,
    }),
    db.contactVerification.count({ where }),
  ]);
  return toPlain({ rows, total });
}

/** Everything ever said about this company's details, for its own 360 view. */
export async function companyVerifications(companyId: string) {
  const user = await requireUser();
  if (!(await mayWorkWithContactsOf(user.id, companyId))) return [];
  return toPlain(
    await db.contactVerification.findMany({
      where: { companyId },
      orderBy: { verifiedAt: "desc" },
      take: 50,
      select: verificationSelect,
    }),
  );
}

export async function verificationSummary() {
  const user = await requireUser();
  const scope = await verificationScope(user.id);
  const [pending, corrections, wrong] = await Promise.all([
    db.contactVerification.count({ where: { AND: [scope, { appliedAt: null }] } }),
    db.contactVerification.count({ where: { AND: [scope, { appliedAt: null, status: "CORRECTED" }] } }),
    db.contactVerification.count({ where: { AND: [scope, { status: "WRONG" }] } }),
  ]);
  return { pending, corrections, wrong };
}
