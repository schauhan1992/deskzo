"use server";

import { customSearchWhere } from "@/lib/custom-fields/server";
import { Prisma, type ContactDesignation, type CompanyRelationshipType } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { contactScope, contactIdsInScope, NO_CONTACTS, seesResellerContactDetails } from "@/lib/authz/contact-access";
import { isResellerManaged, redactContactDetails } from "@/lib/reseller";
import { pageSlice } from "@/lib/pagination";
import { noteRecordsRead } from "@/lib/security/bulk-read";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit";
import { bulkUpdateContactsSchema } from "@/lib/validation/company";
import type { ActionResult } from "@/actions/company";

type ContactListParams = {
  search?: string;
  designation?: ContactDesignation;
  relationshipType?: CompanyRelationshipType;
  industryId?: string;
  primaryOnly?: boolean;
};

function contactListWhere(params?: ContactListParams, custom: Prisma.ContactWhereInput[] = []): Prisma.ContactWhereInput {
  return {
    ...(params?.designation ? { designation: params.designation } : {}),
    ...(params?.primaryOnly ? { isPrimary: true } : {}),
    ...(params?.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" as const } },
            { email: { contains: params.search, mode: "insensitive" as const } },
            { phone: { contains: params.search, mode: "insensitive" as const } },
            { company: { name: { contains: params.search, mode: "insensitive" as const } } },
            // The workspace's own contact fields this person may see (src/lib/custom-fields).
            ...custom,
          ],
        }
      : {}),
    company: {
      ...(params?.relationshipType ? { relationshipType: params.relationshipType } : {}),
      ...(params?.industryId ? { industryId: params.industryId } : {}),
    },
  };
}

/**
 * The list's filters plus the account scope — a contact hangs off a company directly, so its
 * account manager is whose contact it is.
 *
 * `AND` rather than a spread, and that is the whole reason this helper exists: `contactListWhere`
 * already writes a `company` key for the relationship-type and industry filters, so spreading
 * `viaCompanyScope` over it would drop whichever of the two came first — silently widening the
 * list back out, or silently dropping the filter the user chose.
 *
 * This is a different axis from `contacts.viewRestricted` below and neither replaces the other:
 * the scope decides which rows come back at all, redaction decides whether a row that did come
 * back shows its email and phone. A reseller-managed contact out of scope is caught by both.
 */
async function scopedContactWhere(userId: string, params?: ContactListParams): Promise<Prisma.ContactWhereInput> {
  const custom = (await customSearchWhere("CONTACT", userId, params?.search)) as Prisma.ContactWhereInput[];
  return { AND: [contactListWhere(params, custom), await contactScope(userId)] };
}

const contactListInclude = {
  company: {
    select: {
      id: true,
      name: true,
      relationshipType: true,
      managedByResellerId: true,
      managedByReseller: { select: { id: true, name: true } },
      industry: { select: { id: true, name: true } },
    },
  },
} as const;

type RawContact = Prisma.ContactGetPayload<{ include: typeof contactListInclude }>;

/**
 * A reseller's end customers are off limits, so their email/phone never leave the server for anyone
 * without `contacts.viewRestricted` — searching by email can't reveal them either, since a match
 * still comes back redacted.
 */
async function redactList(userId: string, contacts: RawContact[]) {
  const hasRestricted = contacts.some((c) => isResellerManaged(c.company));
  const canViewRestricted = hasRestricted ? await seesResellerContactDetails(userId) : true;
  return contacts.map((c) =>
    redactContactDetails(c, { restricted: isResellerManaged(c.company), canViewRestricted }),
  );
}

export async function listAllContacts(params?: ContactListParams) {
  const user = await requireUser();
  const contacts = await db.contact.findMany({
    where: await scopedContactWhere(user.id, params),
    include: contactListInclude,
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
  });
  return redactList(user.id, contacts);
}

export async function listAllContactsPaged(params: ContactListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  const where = await scopedContactWhere(user.id, params);
  const [contacts, total] = await Promise.all([
    db.contact.findMany({
      where,
      include: contactListInclude,
      orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
      ...pageSlice(params.page, params.pageSize),
    }),
    db.contact.count({ where }),
  ]);
  // Contacts are the highest-value thing in here to collect — a name, an address and a phone
  // number per row — so this is the list worth counting. Not awaited: the check is for the
  // admins, and a slow write to the alert path should never be what makes the page slow.
  void noteRecordsRead({
    userId: user.id,
    userName: user.name,
    count: contacts.length,
    what: "the contacts library",
  });
  return { rows: await redactList(user.id, contacts), total };
}

/**
 * Bulk edits from the Contacts library. Delete is a distinct action rather than another dropdown
 * value, so a mis-click while changing designations can't remove records; contacts attached to a
 * lead are reported back by name instead of failing the whole batch silently.
 */
export async function bulkUpdateContacts(input: unknown): Promise<ActionResult<{ count: number; skipped: number }>> {
  const user = await requireUser();
  const parsed = bulkUpdateContactsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { contactIds, designation, action } = parsed.data;

  /**
   * Every selected contact must be one this person may see. This deleted or re-designated any ids
   * it was handed, whichever account they belonged to. All or nothing, like the other bulk bars.
   */
  const allowed = await contactIdsInScope(user.id, contactIds);
  if (allowed.length !== new Set(contactIds).size) {
    return { ok: false, error: allowed.length === 0 ? NO_CONTACTS : "Some of the selected contacts are not yours to change." };
  }

  if (action === "delete") {
    let deleted = 0;
    let skipped = 0;
    for (const id of contactIds) {
      try {
        await db.contact.delete({ where: { id } });
        deleted += 1;
      } catch (err) {
        // A contact that owns a lead is a foreign-key anchor, not a deletable row.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Contact",
      entityId: contactIds[0],
      entityLabel: `Bulk deleted ${deleted} contact(s)`,
    });
    revalidatePath("/contacts");
    return { ok: true, data: { count: deleted, skipped } };
  }

  if (!designation) return { ok: false, error: "Pick a designation to apply." };

  const result = await db.contact.updateMany({ where: { id: { in: contactIds } }, data: { designation } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Contact",
    entityId: contactIds[0],
    entityLabel: `Bulk set designation on ${result.count} contact(s)`,
  });
  revalidatePath("/contacts");
  return { ok: true, data: { count: result.count, skipped: 0 } };
}
