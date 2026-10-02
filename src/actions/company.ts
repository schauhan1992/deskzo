"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type CompanyStage, type CompanySource, type CompanyRelationshipType, type VendorStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { mayChangeAccountManager, mayChangeCaller, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { dateRangeFilter } from "@/lib/utils";
import { pageSlice } from "@/lib/pagination";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { noteRecordsRead } from "@/lib/security/bulk-read";
import { isResellerManaged, redactContactDetails } from "@/lib/reseller";
import { toPlain } from "@/lib/serialize";
import { formatCompanyId, formatOrderId } from "@/lib/order-id";
import {
  createCompanySchema,
  updateCompanySchema,
  assignCompaniesSchema,
  bulkUpdateCompaniesSchema,
  contactInputSchema,
  updateContactSchema,
  normalizeCompanyName,
  payoutDetailsSchema,
  vendorRelationshipTypeValues,
  customerRelationshipTypeValues,
  isVendorRelationshipType,
  isCustomerRelationshipType,
  type CreateCompanyInput,
} from "@/lib/validation/company";
import { addCompanyProductSchema, updateCompanyProductSchema } from "@/lib/validation/company-product";
import { countForBand } from "@/lib/company-size";
import {
  mayWorkWithContactsOf,
  canViewContacts,
  NO_CONTACTS,
  contactDetailFieldKeys,
  contactDetailsHiddenAt,
  seesResellerContactDetails,
} from "@/lib/authz/contact-access";
import { checkTerms, recordDecision } from "@/lib/credit/guard";
import { CATEGORY_SELECT } from "@/lib/customers/categories";
import {
  changedLabel,
  customFieldsForCreate,
  customSearchWhere,
  formSetup,
  saveCustomFields,
} from "@/lib/custom-fields/server";

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** A category a form sent is still there — none at all is fine. */
async function categoryExists(id: string | undefined): Promise<boolean> {
  if (!id) return true;
  return !!(await db.customerCategory.findUnique({ where: { id }, select: { id: true } }));
}

/** Which module owns a company — each is a separate directory, and records don't move between them. */
function relationshipFamily(type: CompanyRelationshipType): "client" | "reseller" | "commission-party" | "vendor" {
  if (type === "CLIENT") return "client";
  if (type === "RESELLER") return "reseller";
  if (type === "COMMISSION_PARTY") return "commission-party";
  return "vendor";
}

/**
 * The company's own columns, from a form.
 *
 * `currentEmployeeCount` is what is stored now, if anything — so choosing the band a precise count
 * already falls in keeps that count rather than rounding it down to the band. See `countForBand`.
 */
function companyScalarData(
  input: Omit<CreateCompanyInput, "contacts" | "location">,
  currentEmployeeCount: number | null = null,
) {
  return {
    name: input.name.trim(),
    normalizedName: normalizeCompanyName(input.name),
    industryId: input.industryId || null,
    // The old free-text category, left alone unless something still sends it — see customerCategoryId.
    ...(input.category !== undefined ? { category: input.category || null } : {}),
    ...(input.customerCategoryId !== undefined ? { customerCategoryId: input.customerCategoryId || null } : {}),
    companyType: input.companyType || null,
    relationshipType: input.relationshipType,
    website: input.website || null,
    linkedinUrl: input.linkedinUrl || null,
    employeeCount: countForBand(input.employeeBand, currentEmployeeCount),
    paymentTerms: input.paymentTerms,
    dunsNumber: input.dunsNumber || null,
    tags: input.tags,
    source: input.source,
  };
}

export type CompanyMatch = {
  id: string;
  /** The clean reference, e.g. CMP-000123 — what the link opens. */
  ref: string;
  name: string;
  city: string | null;
  relationshipType: CompanyRelationshipType;
  owner: string | null;
};

export type CompanyMatches = {
  /** Companies this user can open whose name contains what was typed, closest first. */
  matches: CompanyMatch[];
  /**
   * The one that would make saving fail — same name once normalised. `visible: false` when it exists
   * but is assigned to somebody else: saying so is no more than `createCompany` itself says on the
   * way out, and it is said before the rest of the form has been filled in rather than after.
   */
  duplicate: { visible: true; match: CompanyMatch } | { visible: false } | null;
};

/**
 * What is already in the CRM under a name, while it is still being typed.
 *
 * The create form's promise — "if it already exists, open the existing record instead" — used to be
 * kept only at Save, after every other field had been filled in. This keeps it at the first letter,
 * the way the company picker on a lead does.
 *
 * Scoped like every other company read: a rep sees their own accounts. The duplicate check is not,
 * because `normalizedName` is unique across the whole table and the save will be refused whoever
 * owns the other row — so the form says a duplicate exists without saying anything else about it.
 */
export async function findCompanyMatches(query: string): Promise<CompanyMatches> {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (!typed) return { matches: [], duplicate: null };
  const normalizedName = normalizeCompanyName(typed);

  const [found, exact] = await Promise.all([
    db.company.findMany({
      // By the normalised name, the one the duplicate rule uses — searching the raw text let "acme   ltd"
      // (extra spaces) miss "Acme Ltd", and the exact match was then reported as somebody else's.
      where: { ...(await companyScope(user.id)), normalizedName: { contains: normalizedName } },
      select: {
        id: true,
        companySeq: true,
        name: true,
        normalizedName: true,
        relationshipType: true,
        owner: { select: { name: true } },
        locations: { select: { city: true }, take: 1, orderBy: { createdAt: "asc" } },
      },
      orderBy: { name: "asc" },
      take: 40,
    }),
    db.company.findUnique({ where: { normalizedName }, select: { id: true } }),
  ]);

  // The same name first, then names that start with what was typed, then the rest — which is the
  // order a person scans for "is it this one?".
  const rank = (c: (typeof found)[number]) =>
    c.normalizedName === normalizedName ? 0 : c.normalizedName.startsWith(normalizedName) ? 1 : 2;
  const toMatch = (c: (typeof found)[number]): CompanyMatch => ({
    id: c.id,
    ref: formatCompanyId(c.companySeq),
    name: c.name,
    city: c.locations[0]?.city ?? null,
    relationshipType: c.relationshipType,
    owner: c.owner?.name ?? null,
  });
  const ranked = [...found].sort((a, b) => rank(a) - rank(b));
  const visibleDuplicate = exact ? ranked.find((c) => c.id === exact.id) : undefined;

  return {
    matches: ranked.filter((c) => c.id !== exact?.id).slice(0, 8).map(toMatch),
    duplicate: exact ? (visibleDuplicate ? { visible: true, match: toMatch(visibleDuplicate) } : { visible: false }) : null,
  };
}

export async function createCompany(
  input: unknown,
): Promise<ActionResult<{ id: string; contacts: { id: string; name: string; designation: string }[] }>> {
  const user = await requireUser();
  const parsed = createCompanySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { contacts, location, managedByResellerId, customFields, ...companyInput } = parsed.data;
  if (!(await categoryExists(companyInput.customerCategoryId))) return { ok: false, error: "That customer category isn't there any more — pick another." };
  // The form leaves the contacts section out for someone without `contacts.view`; this is the same
  // rule for a caller that sends them anyway.
  if (contacts.length > 0 && !(await canViewContacts(user.id))) {
    return { ok: false, error: `${NO_CONTACTS} Create the company without them.` };
  }
  const normalizedName = normalizeCompanyName(companyInput.name);

  const existing = await db.company.findUnique({ where: { normalizedName } });
  if (existing) {
    return {
      ok: false,
      error: `"${existing.name}" already exists in the system — open the existing record instead of creating a duplicate.`,
    };
  }
  // Longer terms than a new customer's (non-)record supports need an override — see src/lib/credit/guard.ts.
  const termsCheck = await checkTerms({
    userId: user.id,
    companyId: null,
    relationshipType: companyInput.relationshipType,
    terms: companyInput.paymentTerms,
    reason: companyInput.creditOverrideReason,
    subject: "Default terms",
  });
  if (!termsCheck.ok) return { ok: false, error: termsCheck.error };

  if (managedByResellerId) {
    const reseller = await db.company.findUnique({ where: { id: managedByResellerId } });
    if (!reseller || reseller.relationshipType !== "RESELLER") {
      return { ok: false, error: "That's not a reseller." };
    }
  }
  // The workspace's own fields (src/lib/custom-fields), the required ones answered. The contacts
  // created with the company are created without theirs: those are filled in on each contact.
  const custom = await customFieldsForCreate("COMPANY", user.id, customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };

  try {
    const company = await db.company.create({
      data: {
        ...companyScalarData(companyInput),
        // New vendor-type companies always start in the onboarding stage — customer-side companies don't use this field.
        vendorStatus: isCustomerRelationshipType(companyInput.relationshipType) ? null : "ONBOARDING",
        managedByResellerId: managedByResellerId ?? null,
        // Every reseller starts with an onboarding profile, so the checklist and the order gate
        // never have to cope with a missing one.
        resellerProfile: companyInput.relationshipType === "RESELLER" ? { create: {} } : undefined,
        createdById: user.id,
        /**
         * Whoever adds an account manages it until somebody says otherwise.
         *
         * This was unset, which did not matter while everybody saw every company and matters a
         * great deal now that they do not: a company with no account manager is nobody's, and the
         * rule in `company-scope.ts` deliberately hides those from anyone without
         * `companies.viewAll`. So a sales executive would add a customer, be returned to the list,
         * and not find it — having created a record only other people could see.
         *
         * Reassigning is one click on the company itself (`setCompanyOwner`), so this is a default
         * rather than a decision.
         */
        ownerUserId: user.id,
        ...custom.data,
        contacts: {
          create: contacts.map((c) => ({
            name: c.name.trim(),
            designation: c.designation,
            email: c.email || null,
            phone: c.phone || null,
            linkedinUrl: c.linkedinUrl || null,
            isPrimary: c.isPrimary,
            receivesDocuments: c.receivesDocuments,
          })),
        },
        locations: {
          create: [
            {
              label: location.label || "Head Office",
              address: location.address || null,
              city: location.city || null,
              state: location.state || null,
              country: location.country || null,
              // Dropped until now: the form collected a PIN and this never wrote it, so every
              // company created from the app had an address with no PIN code at all.
              pincode: location.pincode || null,
              gstNumber: location.gstNumber || null,
              gstTreatment: location.gstTreatment,
              isPrimary: true,
              /**
               * The only address a new company has is its billing and its shipping address.
               *
               * The schema says as much — "both until somebody says otherwise" — but these were never
               * written, so the column default of false won, and a company created from the app had
               * no billing address for its first invoice to default from.
               */
              isBilling: true,
              isShipping: true,
            },
          ],
        },
      },
      // Returned so a form that created a contact alongside the company can select it straight away.
      select: { id: true, name: true, contacts: { select: { id: true, name: true, designation: true } } },
    });

    if (termsCheck.decision) {
      await recordDecision({ userId: user.id, companyId: company.id, kind: "TERMS", ...termsCheck.decision });
    }
    await recordAudit({ userId: user.id, action: "CREATE", entityType: "Company", entityId: company.id, entityLabel: company.name });

    revalidatePath("/companies");
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
    return { ok: true, data: { id: company.id, contacts: company.contacts } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A company with this name already exists." };
    }
    throw err;
  }
}

export async function updateCompany(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = updateCompanySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const { id, ...companyInput } = parsed.data;
  if (!(await categoryExists(companyInput.customerCategoryId))) return { ok: false, error: "That customer category isn't there any more — pick another." };
  const normalizedName = normalizeCompanyName(companyInput.name);

  const [existing, current] = await Promise.all([
    db.company.findUnique({ where: { normalizedName } }),
    db.company.findUnique({ where: { id } }),
  ]);
  if (existing && existing.id !== id) {
    return {
      ok: false,
      error: `"${existing.name}" already exists in the system — company names must be unique.`,
    };
  }
  /**
   * Scoped like every other company write. This took any id and saved over it — the profile, the
   * payment terms, the relationship — whoever's account it was.
   */
  if (!current || !(await canSeeCompany(user.id, current.ownerUserId))) {
    return { ok: false, error: "Company not found." };
  }
  const termsCheck = await checkTerms({
    userId: user.id,
    companyId: id,
    relationshipType: companyInput.relationshipType,
    terms: companyInput.paymentTerms,
    previousTerms: current.paymentTerms,
    reason: companyInput.creditOverrideReason,
    subject: "Default terms",
  });
  if (!termsCheck.ok) return { ok: false, error: termsCheck.error };
  // Re-typing within a family is fine (Vendor to Distributor); crossing one isn't. A customer moved
  // to a vendor family drops out of Companies/Customer and loses the tabs holding its order history,
  // and a commission party moved out orphans its linked companies and payee accounts.
  if (relationshipFamily(companyInput.relationshipType) !== relationshipFamily(current.relationshipType)) {
    return {
      ok: false,
      error: "A company can't be moved between the client, reseller, vendor, and commission party modules — create the record in the right module instead.",
    };
  }

  // Flipping to/from CLIENT resets the vendor onboarding status; otherwise leave whatever the
  // dedicated vendor-status control already set (editing the profile shouldn't reset onboarding progress).
  const vendorStatus =
    companyInput.relationshipType === "CLIENT"
      ? null
      : current.relationshipType === "CLIENT"
        ? "ONBOARDING"
        : (current.vendorStatus ?? "ONBOARDING");

  try {
    await db.company.update({
      where: { id },
      data: { ...companyScalarData(companyInput, current.employeeCount), vendorStatus },
    });

    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: id, entityLabel: companyInput.name });
    if (termsCheck.decision) {
      await recordDecision({ userId: user.id, companyId: id, kind: "TERMS", ...termsCheck.decision });
    }

    revalidatePath("/companies");
    revalidatePath(`/companies/${id}`);
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
    return { ok: true, data: { id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "A company with this name already exists." };
    }
    throw err;
  }
}

/**
 * The company's own fields (src/lib/custom-fields), from the "More details" card on its page — bound
 * to the company there. Whoever may edit the company may change them, as `updateCompany` decides it.
 */
export async function updateCompanyCustomFields(companyId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, ownerUserId: true } });
  // Scoped like `updateCompany`: out of scope and missing answer the same.
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) {
    return { ok: false, error: "Company not found." };
  }
  const saved = await saveCustomFields("COMPANY", company.id, user.id, input);
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Company",
      entityId: company.id,
      entityLabel: `${company.name}${changedLabel(saved.changed)}`,
    });
    revalidatePath("/companies");
    revalidatePath(`/companies/${company.id}`);
    revalidatePath("/vendors");
    revalidatePath("/commission-parties");
  }
  return { ok: true, data: null };
}

/**
 * The workspace's own company fields for the quick-create dialog on the lead form, whose page knows
 * nothing of companies — it asks only the required ones, the rest are filled in on the company's page.
 */
export async function companyFieldSetup(): Promise<Awaited<ReturnType<typeof formSetup>>> {
  const user = await requireUser();
  return formSetup("COMPANY", user.id);
}

/**
 * The workspace's own contact fields for a form that adds somebody from another record's page — the
 * new-contact dialog on the lead form, whose page knows nothing of contacts. None for somebody without
 * `contacts.view`, who can't add one.
 */
export async function contactFieldSetup(): Promise<Awaited<ReturnType<typeof formSetup>>> {
  const user = await requireUser();
  if (!(await canViewContacts(user.id))) return { fields: [], values: {}, people: [] };
  return formSetup("CONTACT", user.id);
}

export async function addContact(
  companyId: string,
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await canViewContacts(user.id))) return { ok: false, error: NO_CONTACTS };
  const parsed = contactInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const c = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  /**
   * Scoped like every other company write. This used to check only that the company existed, so any
   * signed-in user could add a contact to any account by id — including one managed by somebody
   * else. Out of scope and non-existent answer the same, so an id cannot be used to find out which
   * accounts are real.
   */
  if (!company || !(await canSeeCompany(user.id, company.ownerUserId))) {
    return { ok: false, error: "Company not found." };
  }
  // The workspace's own fields (src/lib/custom-fields), the required ones answered.
  const custom = await customFieldsForCreate("CONTACT", user.id, c.customFields, { checkRequired: true });
  if (!custom.ok) return { ok: false, error: custom.error };

  const contact = await db.contact.create({
    data: {
      companyId,
      name: c.name.trim(),
      designation: c.designation,
      email: c.email || null,
      phone: c.phone || null,
      linkedinUrl: c.linkedinUrl || null,
      isPrimary: c.isPrimary,
      receivesDocuments: c.receivesDocuments,
      createdByUserId: user.id,
      ...custom.data,
    },
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Contact", entityId: contact.id, entityLabel: contact.name });

  revalidatePath(`/companies/${companyId}`);
  return { ok: true, data: { id: contact.id } };
}

export async function updateContact(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const parsed = updateContactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, customFields, ...c } = parsed.data;

  const contact = await db.contact.findUnique({ where: { id } });
  // Scoped like `addContact`: this edited any contact by id, on any account. Out of scope and
  // missing answer the same.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }

  // A reseller's end customer, edited by somebody who sees its email and phone hidden: both stay as
  // stored, whatever the form sent — it sends them blank, as it shows them.
  const detailsHidden = await contactDetailsHiddenAt(user.id, contact.companyId);

  // The workspace's own fields (src/lib/custom-fields), when the form had them — saved first, so a
  // refusal leaves the contact exactly as it was.
  let changed: string[] = [];
  if (customFields !== undefined) {
    const saved = await saveCustomFields("CONTACT", id, user.id, customFields, { skip: detailsHidden ? await contactDetailFieldKeys() : [] });
    if (!saved.ok) return saved;
    changed = saved.changed;
  }

  await db.contact.update({
    where: { id },
    data: {
      name: c.name.trim(),
      designation: c.designation,
      ...(detailsHidden ? {} : { email: c.email || null, phone: c.phone || null }),
      linkedinUrl: c.linkedinUrl || null,
      isPrimary: c.isPrimary,
      receivesDocuments: c.receivesDocuments,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Contact", entityId: id, entityLabel: `${c.name.trim()}${changedLabel(changed)}` });

  revalidatePath(`/companies/${contact.companyId}`);
  return { ok: true, data: { id } };
}

/**
 * A contact's own fields (src/lib/custom-fields) by themselves — bound to the contact where they are
 * edited. Whoever may edit the contact may change them, as `updateContact` decides it.
 */
export async function updateContactCustomFields(contactId: string, input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true, name: true, companyId: true } });
  // Scoped like `updateContact`: out of scope and missing answer the same.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }
  // A reseller's end customer's contact-detail fields, for somebody who sees them hidden: kept as stored.
  const skip = (await contactDetailsHiddenAt(user.id, contact.companyId)) ? await contactDetailFieldKeys() : [];
  const saved = await saveCustomFields("CONTACT", contact.id, user.id, input, { skip });
  if (!saved.ok) return saved;
  if (saved.changed.length > 0) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Contact",
      entityId: contact.id,
      entityLabel: `${contact.name}${changedLabel(saved.changed)}`,
    });
    revalidatePath(`/companies/${contact.companyId}`);
  }
  return { ok: true, data: null };
}

export async function deleteContact(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const contact = await db.contact.findUnique({ where: { id } });
  // Scoped like `addContact`: this deleted any contact by id, on any account.
  if (!contact || !(await mayWorkWithContactsOf(user.id, contact.companyId))) {
    return { ok: false, error: (await canViewContacts(user.id)) ? "Contact not found." : NO_CONTACTS };
  }

  try {
    await db.contact.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: "This contact is linked to a lead and can't be deleted." };
    }
    throw err;
  }

  revalidatePath(`/companies/${contact.companyId}`);
  return { ok: true, data: null };
}

export async function assignCompanies(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireUser();
  const parsed = assignCompaniesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, userId } = parsed.data;

  const assignee = await db.user.findUnique({ where: { id: userId } });
  if (!assignee || !assignee.active) {
    return { ok: false, error: "That person is not a valid, active user." };
  }

  const checked = await checkCallerChange(user.id, companyIds, userId);
  if (!checked.ok) return checked;
  const result = await db.company.updateMany({
    where: { id: { in: companyIds } },
    data: {
      assignedToUserId: userId,
      assignedByUserId: user.id,
      assignedAt: new Date(),
    },
  });
  await auditCallerChange(user.id, checked.data, userId);

  if (userId !== user.id) {
    await notifyUser({
      userId,
      type: "CALLER_ASSIGNED",
      title: "You were assigned as caller",
      message: `${result.count} ${result.count === 1 ? "company" : "companies"} assigned to you for lead generation`,
      link: "/companies",
    });
  }

  revalidatePath("/companies");
  revalidatePath("/customers");
  return { ok: true, data: { count: result.count } };
}

/**
 * The caller is who's working this company for lead generation — distinct from the account
 * manager (`setCompanyOwner`), who services the account once it's a customer. Both can be set on
 * the same company at once; this is the single-record counterpart to the bulk `assignCompanies`
 * (same underlying `assignedToUserId`/`assignedByUserId`/`assignedAt` fields), and the only path
 * that can clear an assignment back to unassigned.
 */
export async function setCompanyCaller(companyId: string, userId: string | null): Promise<ActionResult<null>> {
  const actor = await requireUser();
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, ownerUserId: true, assignedToUserId: true },
  });
  if (!company || !(await canSeeCompany(actor.id, company.ownerUserId))) {
    return { ok: false, error: "Company not found." };
  }
  const rights = await reassignRights(actor.id);
  if (!mayChangeCaller(rights, actor.id, company)) {
    return { ok: false, error: "You can't change who calls this account." };
  }
  if (!userId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand it to a colleague — only someone who can reassign accounts may leave it with no caller." };
  }
  if (userId) {
    const caller = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!caller?.active) return { ok: false, error: "That person is not a valid, active user." };
  }
  if ((userId ?? null) === company.assignedToUserId) return { ok: true, data: null };

  await db.company.update({
    where: { id: companyId },
    data: userId
      ? { assignedToUserId: userId, assignedByUserId: actor.id, assignedAt: new Date() }
      : { assignedToUserId: null, assignedByUserId: null, assignedAt: null },
  });
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — caller: ${await nameOf(company.assignedToUserId)} → ${await nameOf(userId)}`,
  });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "CALLER_ASSIGNED",
      title: "You were assigned as caller",
      message: company.name,
      link: `/companies/${companyId}`,
    });
  }

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/companies");
  revalidatePath("/customers");
  return { ok: true, data: null };
}

/** A person's name for the activity log — or "nobody". */
async function nameOf(userId: string | null | undefined): Promise<string> {
  if (!userId) return "nobody";
  return (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "a removed user";
}

/**
 * Whether this person may set the caller on every one of these companies — see src/lib/authz/reassign.ts.
 * All or nothing: a bulk change that silently skipped the rows it was not allowed would leave
 * somebody believing a list was reassigned when half of it was not.
 */
async function checkCallerChange(
  actorId: string,
  companyIds: string[],
  nextId: string | null,
): Promise<ActionResult<{ id: string; name: string; assignedToUserId: string | null }[]>> {
  const rights = await reassignRights(actorId);
  const companies = await db.company.findMany({
    where: { id: { in: companyIds }, ...(await companyScope(actorId)) },
    select: { id: true, name: true, ownerUserId: true, assignedToUserId: true },
  });
  if (companies.length !== new Set(companyIds).size) {
    return { ok: false, error: "Some of the selected companies are not yours to change." };
  }
  const refused = companies.filter((c) => !mayChangeCaller(rights, actorId, c));
  if (refused.length) {
    return {
      ok: false,
      error: `You can't change the caller on ${refused.length === 1 ? refused[0]!.name : `${refused.length} of these companies`} — only on accounts you manage or call.`,
    };
  }
  if (!nextId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand them to a colleague — only someone who can reassign accounts may leave them with no caller." };
  }
  return { ok: true, data: companies };
}

/** One activity-log line per company whose caller actually changes. */
async function auditCallerChange(actorId: string, companies: { id: string; name: string; assignedToUserId: string | null }[], nextId: string | null) {
  const to = await nameOf(nextId);
  for (const c of companies) {
    if (c.assignedToUserId === nextId) continue;
    await recordAudit({
      userId: actorId,
      action: "UPDATE",
      entityType: "Company",
      entityId: c.id,
      entityLabel: `${c.name} — caller: ${await nameOf(c.assignedToUserId)} → ${to}`,
    });
  }
}

export async function setCompanyOwner(companyId: string, userId: string | null): Promise<ActionResult<null>> {
  const actor = await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, ownerUserId: true } });
  // Outside the account scope is answered as missing — and this check comes first because the
  // account manager *is* the scope: without it, naming yourself was a way to see any company.
  if (!company || !(await canSeeCompany(actor.id, company.ownerUserId))) {
    return { ok: false, error: "Company not found." };
  }
  const rights = await reassignRights(actor.id);
  if (!mayChangeAccountManager(rights, actor.id, company)) {
    return { ok: false, error: "You can't change who manages this account." };
  }
  if (!userId && !mayLeaveUnassigned(rights)) {
    return { ok: false, error: "Hand it to a colleague — only someone who can reassign accounts may leave one with nobody." };
  }
  if (userId) {
    const owner = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
    if (!owner?.active) return { ok: false, error: "That person is not a valid, active user." };
  }
  if ((userId ?? null) === company.ownerUserId) return { ok: true, data: null };

  await db.company.update({ where: { id: companyId }, data: { ownerUserId: userId } });
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyId,
    entityLabel: `${company.name} — account manager: ${await nameOf(company.ownerUserId)} → ${await nameOf(userId)}`,
  });

  if (userId && userId !== actor.id) {
    await notifyUser({
      userId,
      type: "ACCOUNT_MANAGER_ASSIGNED",
      title: "You were made account manager",
      message: company.name,
      link: `/companies/${companyId}`,
    });
  }

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/companies");
  return { ok: true, data: null };
}

export async function setVendorStatus(companyId: string, status: VendorStatus): Promise<ActionResult<null>> {
  await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }
  if (company.relationshipType === "CLIENT") {
    return { ok: false, error: "Only vendor-type companies have a vendor status." };
  }

  await db.company.update({ where: { id: companyId }, data: { vendorStatus: status } });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

export async function setVendorCode(companyId: string, code: string): Promise<ActionResult<null>> {
  await requireUser();
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }

  await db.company.update({ where: { id: companyId }, data: { vendorCode: code.trim() || null } });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

/** Payout/compliance details (PAN, bank account) — edited separately from the main profile, same pattern as `setVendorCode`. */
export async function setPayoutDetails(companyId: string, input: unknown): Promise<ActionResult<null>> {
  await requireUser();
  const parsed = payoutDetailsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }

  const data = parsed.data;
  await db.company.update({
    where: { id: companyId },
    data: {
      panNumber: data.panNumber || null,
      bankAccountName: data.bankAccountName || null,
      bankAccountNumber: data.bankAccountNumber || null,
      bankIfsc: data.bankIfsc || null,
      bankName: data.bankName || null,
    },
  });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/vendors");
  revalidatePath("/commission-parties");
  return { ok: true, data: null };
}

export async function listAssignableUsers() {
  await requireUser();
  return db.user.findMany({
    where: { active: true },
    orderBy: { name: "asc" },
    // Email and work phone travel with the name because a quote names the person who sent it
    // and the customer has to be able to reach them. Neither is a secret from a colleague —
    // both are already on the user's own screen and on every document they raise.
    select: { id: true, name: true, role: true, email: true, phone: true },
  });
}

/**
 * The Companies module's list — the raw CLIENT-track sourcing pool (prospects/leads/won-deals).
 * Vendors, OEMs, distributors, partners, and commission parties live in their own dedicated
 * modules (`/vendors`, `/commission-parties`) and are deliberately excluded here by default, same
 * as `listCustomers`. `relationshipType` can still override this (kept for flexibility), but the
 * `/companies` page itself never passes anything other than the default.
 */
type CompanyListParams = {
  stage?: CompanyStage;
  /** Only meaningful alongside `stage: "CUSTOMER"` — true = has at least one order on file (even an expired one), false = a won deal with no order recorded yet ("Awaiting Order"). Undefined = don't filter on it. */
  hasOrders?: boolean;
  search?: string;
  assignedToUserId?: string;
  source?: CompanySource;
  industryId?: string;
  /** A category — which takes in its sub-categories — or one sub-category. */
  categoryId?: string;
  relationshipType?: CompanyRelationshipType;
  createdFrom?: string;
  createdTo?: string;
};

/**
 * The search box on the company lists: the name, or one of the workspace's own fields this person may
 * see (src/lib/custom-fields/server.ts `customSearchWhere`, passed in by the list action). In `AND`
 * rather than spread as `OR`: `categoryFilter` writes an `OR` of its own, and two would keep only
 * whichever came last.
 */
function companySearch(search: string, custom: Prisma.CompanyWhereInput[]): Prisma.CompanyWhereInput {
  const byName = { normalizedName: { contains: normalizeCompanyName(search) } };
  return custom.length > 0 ? { AND: [{ OR: [byName, ...custom] }] } : byName;
}

/** `customSearchWhere` for companies, typed for the list builders. */
async function companyCustomSearch(userId: string, search: string | undefined): Promise<Prisma.CompanyWhereInput[]> {
  return (await customSearchWhere("COMPANY", userId, search)) as Prisma.CompanyWhereInput[];
}

function companyListWhere(params?: CompanyListParams, custom: Prisma.CompanyWhereInput[] = []): Prisma.CompanyWhereInput {
  const createdAt = dateRangeFilter(params?.createdFrom, params?.createdTo);
  return {
    relationshipType: params?.relationshipType ?? "CLIENT",
    // A reseller's end customer is theirs to call, not ours — keep them out of the sourcing pool.
    managedByResellerId: null,
    ...(params?.stage ? { stage: params.stage } : {}),
    ...(params?.hasOrders === true ? { products: { some: {} } } : {}),
    ...(params?.hasOrders === false ? { products: { none: {} } } : {}),
    ...(params?.search ? companySearch(params.search, custom) : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...categoryFilter(params?.categoryId),
    ...(createdAt ? { createdAt } : {}),
  };
}

/** A category takes in its sub-categories: "Strategic" lists the key accounts too. */
function categoryFilter(categoryId?: string): Prisma.CompanyWhereInput {
  if (!categoryId) return {};
  if (categoryId === "none") return { customerCategoryId: null };
  return { OR: [{ customerCategoryId: categoryId }, { customerCategory: { parentId: categoryId } }] };
}

const companyListInclude = {
  _count: { select: { contacts: true, leads: true, products: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
  customerCategory: { select: CATEGORY_SELECT },
} as const;

/**
 * Every company list below reaches its company by the shortest possible route — these rows *are*
 * companies, so the scope lands on `ownerUserId` directly and there is no relation to hop through.
 * The fragment is spread rather than written out because `accountScopeIds` returns `null` for a
 * viewer holding `companies.viewAll`, and only the fragment turns that into "no clause at all"
 * instead of an `IN ()` that would empty the accounts team's screens. See
 * src/lib/authz/company-scope.ts.
 */
export async function listCompanies(params?: CompanyListParams) {
  const user = await requireUser();
  return db.company.findMany({
    where: { ...companyListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) },
    orderBy: { createdAt: "desc" },
    include: companyListInclude,
  });
}

/** One page of the Companies / Customer lists, plus the unpaginated total for the pager. */
export async function listCompaniesPaged(params: CompanyListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // One `where` for both queries below: a pager whose count outran its rows would offer page 9 of
  // a list that ends at page 2.
  const where = { ...companyListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) };
  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: companyListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
  ]);
  // Counted towards the read-volume check. Deliberately not awaited — see the contacts list for
  // why the alerting path must never be on the critical path of a page load.
  void noteRecordsRead({ userId: user.id, userName: user.name, count: rows.length, what: "the company list" });
  return { rows, total };
}

/**
 * The Customer module's list — every Client-type company that has actually bought something from
 * us (at least one order on file in Products & Subscriptions, active or expired — a won deal with
 * no order yet doesn't qualify, see `listCompanies`'s `hasOrders: false` "Awaiting Order" bucket).
 * Same shape as `listCompanies` so it's plug-compatible with `CompaniesTable`.
 */
type CustomerListParams = {
  search?: string;
  assignedToUserId?: string;
  source?: CompanySource;
  industryId?: string;
  categoryId?: string;
  createdFrom?: string;
  createdTo?: string;
};

function customerListWhere(params?: CustomerListParams, custom: Prisma.CompanyWhereInput[] = []): Prisma.CompanyWhereInput {
  const createdAt = dateRangeFilter(params?.createdFrom, params?.createdTo);
  return {
    relationshipType: "CLIENT",
    // Resellers have their own module, and their end customers are never our customer — the
    // reseller is who bought from us.
    managedByResellerId: null,
    products: { some: {} },
    ...(params?.search ? companySearch(params.search, custom) : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...categoryFilter(params?.categoryId),
    ...(createdAt ? { createdAt } : {}),
  };
}

export async function listCustomers(params?: CustomerListParams) {
  const user = await requireUser();
  return db.company.findMany({
    where: { ...customerListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) },
    orderBy: { createdAt: "desc" },
    include: companyListInclude,
  });
}

export async function listCustomersPaged(params: CustomerListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  const where = { ...customerListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) };
  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: companyListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
  ]);
  return { rows, total };
}

/**
 * The Vendors module's list — every company that isn't a Client or a Commission Party
 * (Vendor/OEM/Distributor/Partner/Other), same shape as `listCompanies` so it's plug-compatible
 * with `CompaniesTable`. Also reused by the Commission Parties page, which passes an explicit
 * `relationshipType: "COMMISSION_PARTY"` to override the default exclusion.
 */
type VendorListParams = {
  search?: string;
  assignedToUserId?: string;
  source?: CompanySource;
  industryId?: string;
  relationshipType?: CompanyRelationshipType;
  vendorStatus?: VendorStatus;
  createdFrom?: string;
  createdTo?: string;
};

function vendorListWhere(params?: VendorListParams, custom: Prisma.CompanyWhereInput[] = []): Prisma.CompanyWhereInput {
  const createdAt = dateRangeFilter(params?.createdFrom, params?.createdTo);
  return {
    relationshipType: params?.relationshipType ?? { in: vendorRelationshipTypeValues },
    ...(params?.vendorStatus ? { vendorStatus: params.vendorStatus } : {}),
    ...(params?.search ? companySearch(params.search, custom) : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

const vendorListInclude = {
  _count: { select: { contacts: true, leads: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
} as const;

/**
 * ## Why a vendor list is account-scoped too, when a vendor is somebody we buy *from*
 *
 * The obvious reading is that this isn't a customer list at all and should be left alone. It was
 * worth checking rather than assuming, and what the records say is that `Company.ownerUserId` means
 * the same thing here as it does on a client: every vendor-type company in the database carries one,
 * they are set by the same `setCompanyOwner` action that tells the person "you were made account
 * manager", and they are the same sales people who own the client records. There is no separate
 * "who buys from this supplier" field that would mean something different — it is one column on one
 * table, and `companies.viewAll` is documented as "somebody sees only the companies they are account
 * manager for", not only the customers.
 *
 * The thing that makes this safe rather than merely consistent is that the people who must never
 * lose sight of a supplier are not restricted in the first place: `companies.viewAll` is granted by
 * default to PURCHASE, ACCOUNTS, SUPPORT and MANAGEMENT, so purchasing's own view of this list is
 * untouched. And a sales executive raising an order still picks any vendor they like — that picker
 * is `listVendorOptions`, which is deliberately unscoped for exactly this reason. What narrows here
 * is only *browsing* the supplier book, which also carries PAN and bank-account details.
 */
export async function listVendors(params?: VendorListParams) {
  const user = await requireUser();
  return db.company.findMany({
    where: { ...vendorListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) },
    orderBy: { createdAt: "desc" },
    include: vendorListInclude,
  });
}

/** One page of the Vendors / Commission Parties lists. */
export async function listVendorsPaged(params: VendorListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  const where = { ...vendorListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) };
  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: vendorListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
  ]);
  return { rows, total };
}

/**
 * The companies a picker may offer this person — the `where` behind both `listCompanyOptions` and
 * `searchCustomerOptions`, written once so that searching can never reach further than the list does.
 */
async function companyOptionsWhere(
  userId: string,
  relationshipTypes?: readonly CompanyRelationshipType[],
): Promise<Prisma.CompanyWhereInput> {
  return {
    /**
     * Scoped to the accounts this person manages, or their team's.
     *
     * This list feeds every company picker in the app, and it was returning the whole book to
     * anybody signed in — which is the failure `company-scope.ts` describes as the dangerous one,
     * because a filter that is too wide is never reported. `companies.viewAll` lifts it, and the
     * presets already grant that to the functions that genuinely serve every account: support,
     * purchasing and accounts.
     */
    ...(await companyScope(userId)),
    stage: { not: "DISQUALIFIED" },
    // A reseller's end customer can never be the party we deal with directly — the reseller is.
    managedByResellerId: null,
    ...(relationshipTypes ? { relationshipType: { in: [...relationshipTypes] } } : {}),
  };
}

/** A company as a picker shows it: the name, what kind of account, and the category chip. */
const COMPANY_OPTION_SELECT = {
  id: true,
  name: true,
  relationshipType: true,
  customerCategory: { select: CATEGORY_SELECT },
} as const;

/** A positive whole number of rows to stop at, or no limit — whatever else a caller sends is ignored, not queried with. */
function rowLimit(take: unknown): { take?: number } {
  return typeof take === "number" && Number.isInteger(take) && take > 0 ? { take } : {};
}

/**
 * The company pickers' list. By default every company in reach, each with its contacts — the lead
 * and ticket forms read those.
 *
 * `withContacts: false` leaves the contacts join off for a picker that only shows names; it is most
 * of the payload, and the order form sends this list to the browser. `take` stops at that many rows,
 * for a caller that searches the server for the rest (`searchCustomerOptions`) — ask for one more
 * than you show, and the extra row says the list is incomplete.
 */
export async function listCompanyOptions(params?: {
  relationshipTypes?: CompanyRelationshipType[];
  withContacts?: boolean;
  take?: number;
}) {
  const user = await requireUser();
  const where = await companyOptionsWhere(user.id, params?.relationshipTypes);
  if (params?.withContacts === false) {
    return db.company.findMany({ where, orderBy: { name: "asc" }, ...rowLimit(params.take), select: COMPANY_OPTION_SELECT });
  }
  return db.company.findMany({
    where,
    orderBy: { name: "asc" },
    ...rowLimit(params?.take),
    select: {
      ...COMPANY_OPTION_SELECT,
      contacts: { select: { id: true, name: true, designation: true }, orderBy: { isPrimary: "desc" } },
    },
  });
}

/** How many customers one search answers with — the picker says so when the cap bites. */
const CUSTOMER_SEARCH_LIMIT = 20;

/**
 * Customers whose name contains what was typed, for the order form's picker once the customer book is
 * too long to send to the browser whole.
 *
 * The same accounts `listCompanyOptions` offers for customers — the scope, nothing disqualified, no
 * reseller's end customer — searched rather than listed: two characters at least (one matches most of
 * the book, and says nothing about which customer is meant), the first twenty by name, and no contacts.
 */
export async function searchCustomerOptions(query: string) {
  const user = await requireUser();
  const typed = String(query ?? "").trim().slice(0, 120);
  if (typed.length < 2) return [];
  return db.company.findMany({
    where: {
      ...(await companyOptionsWhere(user.id, customerRelationshipTypeValues)),
      name: { contains: typed, mode: "insensitive" },
    },
    orderBy: { name: "asc" },
    take: CUSTOMER_SEARCH_LIMIT,
    select: COMPANY_OPTION_SELECT,
  });
}

/**
 * The Resellers module's list — channel partners who buy from us for their own customers. Same
 * shape as `listCompanies` so it's plug-compatible with `CompaniesTable`.
 */
type ResellerListParams = {
  search?: string;
  assignedToUserId?: string;
  source?: CompanySource;
  industryId?: string;
  createdFrom?: string;
  createdTo?: string;
};

function resellerListWhere(params?: ResellerListParams, custom: Prisma.CompanyWhereInput[] = []): Prisma.CompanyWhereInput {
  const createdAt = dateRangeFilter(params?.createdFrom, params?.createdTo);
  return {
    relationshipType: "RESELLER",
    ...(params?.search ? companySearch(params.search, custom) : {}),
    ...(params?.assignedToUserId
      ? params.assignedToUserId === "unassigned"
        ? { assignedToUserId: null }
        : { assignedToUserId: params.assignedToUserId }
      : {}),
    ...(params?.source ? { source: params.source } : {}),
    ...(params?.industryId ? { industryId: params.industryId } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

const resellerListInclude = {
  _count: { select: { contacts: true, leads: true, products: true, endCustomers: true } },
  resellerProfile: { select: { status: true, tier: true } },
  owner: { select: { id: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  industry: { select: { id: true, name: true } },
} as const;

/**
 * A reseller is on the buying side — `customerRelationshipTypeValues` counts them as a customer
 * because we invoice the reseller, not their end customer — so this is an account list like any
 * other and scopes the same way.
 */
export async function listResellers(params?: ResellerListParams) {
  const user = await requireUser();
  return db.company.findMany({
    where: { ...resellerListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) },
    orderBy: { createdAt: "desc" },
    include: resellerListInclude,
  });
}

export async function listResellersPaged(params: ResellerListParams & { page: number; pageSize: number }) {
  const user = await requireUser();
  // The end-customer tally below is built from this same `where`, so the scope reaches it for free —
  // it counts end customers of the resellers on screen rather than of every reseller in the business.
  const where = { ...resellerListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)) };
  const [rows, total, endCustomerTotal] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: resellerListInclude,
      ...pageSlice(params.page, params.pageSize),
    }),
    db.company.count({ where }),
    // Counted across every matching reseller, not just this page, so the header doesn't shrink as you page.
    db.company.count({ where: { managedByReseller: { is: where } } }),
  ]);
  return { rows, total, endCustomerTotal };
}

/**
 * The end customers a reseller has bought for — shown on the reseller's page, and the "who is this
 * order for" picker.
 *
 * A guard rather than a filter. The caller names the reseller, so narrowing the rows that come back
 * would protect nothing; the question is whether this viewer may see *that reseller* at all. An end
 * customer is deliberately unreachable except through the reseller who manages it — it is kept out
 * of every other list in this file — so the reseller's account manager is the only line that makes
 * sense to draw. Refusing reads as "this reseller has no end customers", which is a shape every
 * caller already renders.
 */
export async function listEndCustomers(resellerId: string) {
  const user = await requireUser();
  const reseller = await db.company.findUnique({ where: { id: resellerId }, select: { ownerUserId: true } });
  const visible = reseller !== null && (await canSeeCompany(user.id, reseller.ownerUserId));
  return db.company.findMany({
    where: { managedByResellerId: resellerId, ...(visible ? {} : { id: { in: [] } }) },
    orderBy: { name: "asc" },
    select: { id: true, name: true, _count: { select: { ordersAsEndCustomer: true } } },
  });
}

/**
 * Every reseller, for the "is this order via a reseller" pickers.
 *
 * Deliberately unscoped, like `listVendorOptions` and `listCommissionPartyOptions`. The line these
 * three sit on: the *account* a document is raised against is scoped, but the counterparties on that
 * document — who we sourced it from, who gets the commission, which channel it went through — are
 * not, because a rep's own customer can perfectly well buy through a reseller somebody else manages,
 * and blocking that would break punching a legitimate order rather than hide anything. Only a name
 * and an id leave here.
 */
export async function listResellerOptions() {
  await requireUser();
  return db.company.findMany({
    where: { relationshipType: "RESELLER" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/**
 * Customer companies as plain name options — for pickers that render only the name, skipping
 * `listCompanyOptions`'s contacts join.
 *
 * Scoped for the same reason and on the same terms as `listCompanyOptions`: this is the same set of
 * client accounts with one join left off, so leaving it open would be a way round that function's
 * scope rather than a different question.
 */
export async function listClientCompanyNameOptions() {
  const user = await requireUser();
  return db.company.findMany({
    where: {
      ...(await companyScope(user.id)),
      relationshipType: "CLIENT",
      stage: { not: "DISQUALIFIED" },
      managedByResellerId: null,
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/** Every vendor-type company, for the "which vendor was this order purchased from" picker on a customer order — excludes Commission Parties, since they're paid a commission, not sourced from. Unscoped on purpose: see `listResellerOptions`. */
export async function listVendorOptions() {
  await requireUser();
  return db.company.findMany({
    where: { relationshipType: { in: vendorRelationshipTypeValues } },
    orderBy: { name: "asc" },
    select: { id: true, name: true, relationshipType: true, paymentTerms: true },
  });
}

/**
 * Every commission-party company, for the "who is this commission paid to" picker on an order's
 * Commission expense line. When `forCompanyId` is given (the order's customer), parties explicitly
 * linked to that customer are flagged and sorted first — but every commission party is still
 * returned, so punching an order never gets blocked on a link nobody set up yet.
 *
 * Unscoped on purpose, for the same reason: see `listResellerOptions`.
 */
export async function listCommissionPartyOptions(forCompanyId?: string) {
  await requireUser();
  const [parties, linkedIds] = await Promise.all([
    db.company.findMany({
      where: { relationshipType: "COMMISSION_PARTY" },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    forCompanyId
      ? db.commissionPartyLink.findMany({ where: { companyId: forCompanyId }, select: { commissionPartyId: true } })
      : Promise.resolve([]),
  ]);
  const linkedSet = new Set(linkedIds.map((l) => l.commissionPartyId));
  return parties
    .map((p) => ({ ...p, linked: linkedSet.has(p.id) }))
    .sort((a, b) => (a.linked === b.linked ? 0 : a.linked ? -1 : 1));
}

export async function getCompany(id: string) {
  const user = await requireUser();
  const company = await db.company.findUnique({
    where: { id },
    include: {
      managedByReseller: { select: { id: true, name: true } },
      customerCategory: { select: CATEGORY_SELECT },
      contacts: { orderBy: { isPrimary: "desc" } },
      leads: {
        orderBy: { createdAt: "desc" },
        include: {
          owner: { select: { id: true, name: true } },
          contact: { select: { id: true, name: true } },
          activities: {
            orderBy: { occurredAt: "desc" },
            include: { user: { select: { id: true, name: true } } },
          },
          requirements: {
            orderBy: { createdAt: "desc" },
            include: { item: { select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true } } },
          },
        },
      },
      locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      products: {
        orderBy: { createdAt: "desc" },
        include: {
          item: {
            select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true, taxRatePercent: true },
          },
          location: { select: { id: true, label: true, gstNumber: true, state: true } },
          vendor: { select: { id: true, name: true, paymentTerms: true } },
          // On a reseller's own orders, who it was bought for.
          endCustomer: { select: { id: true, name: true } },
          addedBy: { select: { id: true, name: true } },
          // Seats added part-way through the term, so the list can show the running total rather
          // than only what was bought on day one.
          addons: {
            where: { orderStatus: { not: "CANCELLED" } },
            orderBy: { startDate: "asc" },
            select: { id: true, quantity: true, startDate: true, unitPrice: true },
          },
          // Set once a renewal has been punched, so the renewals tab says so rather than
          // offering to punch a second one.
          renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
          allocations: {
            orderBy: { createdAt: "desc" },
            include: {
              allocatedBy: { select: { id: true, name: true } },
              payment: { select: { id: true, paidOn: true, method: true, reference: true } },
            },
          },
        },
      },
      // What a reseller bought *for* this company. The order belongs to the reseller (they're who we
      // invoice), but the product/subscription is this company's — it's their seats, their expiry,
      // their support — so it belongs in their Products & Subscriptions, not the reseller's.
      ordersAsEndCustomer: {
        orderBy: { createdAt: "desc" },
        include: {
          renewedBy: { select: { id: true, orderSeq: true, orderStatus: true } },
          addons: {
            where: { orderStatus: { not: "CANCELLED" } },
            orderBy: { startDate: "asc" },
            select: { id: true, quantity: true, startDate: true, unitPrice: true },
          },
          item: {
            select: { id: true, name: true, sku: true, type: true, unit: true, sellingPrice: true, taxRatePercent: true },
          },
          location: { select: { id: true, label: true, gstNumber: true, state: true } },
          vendor: { select: { id: true, name: true, paymentTerms: true } },
          company: { select: { id: true, name: true } },
          addedBy: { select: { id: true, name: true } },
          allocations: {
            orderBy: { createdAt: "desc" },
            include: {
              allocatedBy: { select: { id: true, name: true } },
              payment: { select: { id: true, paidOn: true, method: true, reference: true } },
            },
          },
        },
      },
      createdBy: { select: { id: true, name: true } },
      owner: { select: { id: true, name: true } },
      assignedTo: { select: { id: true, name: true } },
      assignedBy: { select: { id: true, name: true } },
      industry: { select: { id: true, name: true } },
    },
  });
  if (!company) return null;

  /**
   * The detail view refuses, where a list filters.
   *
   * This is the function that actually matters: the lists above decide what somebody is *offered*,
   * and an id typed into the address bar walks straight past all of them. What comes back here is
   * the whole account — every contact's email and phone, the order book, the payment history, the
   * bank and PAN details on a vendor — so an unscoped `getCompany` would make the rest of this file
   * decorative.
   *
   * `null` rather than an error, deliberately: it is the same answer as "no such company", so a
   * refusal does not confirm that the id exists, and every caller already routes it to `notFound()`.
   */
  if (!(await canSeeCompany(user.id, company.ownerUserId))) return null;

  // Redact here rather than in the page: masking in the component would still ship the real email
  // and phone to the browser for anyone who opens devtools.
  const restricted = isResellerManaged(company);
  const canViewRestricted = restricted ? await seesResellerContactDetails(user.id) : true;
  /**
   * The same rule for the view permissions: a part of the account this person may not see is left
   * out here, not hidden by the page. `getCompany` is an endpoint in its own right, and the customer
   * page is only one of the things that can call it.
   */
  const [seesContacts, seesLeads, seesOrders] = await Promise.all([
    canViewContacts(user.id),
    hasEffectivePermission(user.id, "leads.view"),
    hasEffectivePermission(user.id, "orders.view"),
  ]);
  return toPlain({
    ...company,
    contacts: seesContacts ? company.contacts.map((c) => redactContactDetails(c, { restricted, canViewRestricted })) : [],
    leads: seesLeads ? company.leads : [],
    products: seesOrders ? company.products : [],
    ordersAsEndCustomer: seesOrders ? company.ordersAsEndCustomer : [],
  });
}

export async function addCompanyProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const itemsEnabled = await isModuleEnabled("items");
  if (!itemsEnabled) {
    return { ok: false, error: "The Items & Inventory module is disabled." };
  }
  const parsed = addCompanyProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyId, locationId, itemId, vendorId, quantity, notes, poNumber, startDate, endDate } = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }
  const location = await db.companyLocation.findUnique({ where: { id: locationId } });
  if (!location || location.companyId !== companyId) {
    return { ok: false, error: "That location does not belong to this company." };
  }
  const vendor = await db.company.findUnique({ where: { id: vendorId } });
  if (!vendor || !isVendorRelationshipType(vendor.relationshipType)) {
    return { ok: false, error: "That's not a valid vendor." };
  }

  const product = await db.companyProduct.create({
    data: {
      companyId,
      locationId,
      itemId,
      vendorId,
      quantity,
      notes: notes || null,
      poNumber: poNumber || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      addedByUserId: user.id,
    },
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Order", entityId: product.id, entityLabel: `Order for ${company.name}` });

  revalidatePath(`/companies/${companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: { id: product.id } };
}

export async function updateCompanyProduct(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "products.edit"))) {
    return { ok: false, error: "You don't have permission to edit products." };
  }
  const parsed = updateCompanyProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, locationId, quantity, notes, poNumber, startDate, endDate } = parsed.data;

  const product = await db.companyProduct.findUnique({ where: { id } });
  if (!product) {
    return { ok: false, error: "Product not found." };
  }
  const location = await db.companyLocation.findUnique({ where: { id: locationId } });
  if (!location || location.companyId !== product.companyId) {
    return { ok: false, error: "That location does not belong to this company." };
  }

  await db.companyProduct.update({
    where: { id },
    data: {
      locationId,
      quantity,
      notes: notes || null,
      poNumber: poNumber || null,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    },
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: id, entityLabel: formatOrderId(product.orderSeq) });

  revalidatePath(`/companies/${product.companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: { id } };
}

export async function removeCompanyProduct(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "products.delete"))) {
    return { ok: false, error: "You don't have permission to delete products." };
  }
  const product = await db.companyProduct.findUnique({
    where: { id },
    include: {
      item: { select: { name: true } },
      // Both of these follow the row out through `onDelete: Cascade` and neither was being looked
      // at first.
      addons: { select: { id: true } },
      allocations: { select: { id: true, amount: true, paymentId: true } },
    },
  });
  if (!product) {
    return { ok: false, error: "Product not found." };
  }

  /**
   * What a one-click delete used to take with it, silently.
   *
   * `CompanyProduct.parentId` and `PaymentAllocation.companyProductId` both cascade, so removing a
   * ten-seat subscription also removed the mid-term addons co-termed to it — their pro-rata
   * snapshots and all — and detached the customer's payment from the thing it paid for, while the
   * company's "received" total went on counting it. There was no audit row to reconstruct any of it
   * from.
   *
   * Refused rather than cascaded. A deletion that quietly destroys a sale and unbalances a customer
   * ledger is not a deletion anybody meant to make, and the two things blocking it are both things
   * the person can undo deliberately if they really meant it.
   */
  if (product.addons.length > 0) {
    return {
      ok: false,
      error:
        product.addons.length === 1
          ? "This order has an addon co-termed to it, which would be deleted with it. Remove the addon first."
          : `This order has ${product.addons.length} addons co-termed to it, which would be deleted with it. Remove them first.`,
    };
  }

  if (product.allocations.length > 0) {
    const total = product.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
    return {
      ok: false,
      error: `₹${total.toLocaleString("en-IN", { minimumFractionDigits: 2 })} of payment is applied to this order. Un-apply it first, or the money would be left unallocated with nothing recording why.`,
    };
  }

  await db.companyProduct.delete({ where: { id } });

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CompanyProduct",
    entityId: id,
    entityLabel: `Deleted order for ${product.item?.name ?? "an item"} (qty ${product.quantity})`,
  });

  revalidatePath(`/companies/${product.companyId}`);
  revalidatePath("/renewals");
  return { ok: true, data: null };
}

/**
 * Bulk edits from a company list's selection bar. Vendor status is checked per company rather than
 * applied blindly: only vendor-type companies have one, and letting a mixed selection set it on a
 * client would put a status on a record that has no concept of it.
 */
export async function bulkUpdateCompanies(input: unknown): Promise<ActionResult<{ count: number }>> {
  const user = await requireUser();
  const parsed = bulkUpdateCompaniesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyIds, assignedToUserId, vendorStatus, addTags } = parsed.data;
  if (!assignedToUserId && !vendorStatus && addTags.length === 0) {
    return { ok: false, error: "Pick something to apply to the selection." };
  }

  /**
   * Only companies this person can see — for every part of this action, not just the caller.
   *
   * It took any ids, so vendor status, tags and the caller could all be changed on accounts the
   * person could not open. A selection comes from a list that is already scoped, so a mismatch
   * means a crafted request, and it is refused whole rather than applied to the part that fits.
   */
  const companies = await db.company.findMany({
    where: { id: { in: companyIds }, ...(await companyScope(user.id)) },
    select: { id: true, relationshipType: true, tags: true },
  });
  if (companies.length === 0) return { ok: false, error: "Those companies no longer exist." };
  if (companies.length !== new Set(companyIds).size) {
    return { ok: false, error: "Some of the selected companies are not yours to change." };
  }

  if (vendorStatus) {
    const clients = companies.filter((c) => c.relationshipType === "CLIENT");
    if (clients.length > 0) {
      return { ok: false, error: `${clients.length} of the selected companies are clients, which don't have a vendor status.` };
    }
    await db.company.updateMany({ where: { id: { in: companyIds } }, data: { vendorStatus } });
  }

  if (assignedToUserId) {
    const nextId = assignedToUserId === "unassign" ? null : assignedToUserId;
    if (nextId) {
      const assignee = await db.user.findUnique({ where: { id: nextId }, select: { id: true, active: true } });
      if (!assignee || !assignee.active) return { ok: false, error: "That person is not a valid, active user." };
    }
    const checked = await checkCallerChange(user.id, companyIds, nextId);
    if (!checked.ok) return checked;
    await db.company.updateMany({
      where: { id: { in: companyIds } },
      data: {
        assignedToUserId: nextId,
        assignedByUserId: nextId ? user.id : null,
        assignedAt: nextId ? new Date() : null,
      },
    });
    // After the write, from the values read before it — a log line for a change that failed is a lie.
    await auditCallerChange(user.id, checked.data, nextId);
    if (nextId && nextId !== user.id) {
      await notifyUser({
        userId: nextId,
        type: "CALLER_ASSIGNED",
        title: "You were assigned as caller",
        message: `${companyIds.length} ${companyIds.length === 1 ? "company" : "companies"} assigned to you`,
        link: "/companies",
      });
    }
  }

  // Tags are added rather than replaced — a bulk action that silently wiped every existing tag
  // would be a data-loss button wearing a helpful label.
  if (addTags.length > 0) {
    for (const company of companies) {
      const merged = Array.from(new Set([...company.tags, ...addTags]));
      if (merged.length !== company.tags.length) {
        await db.company.update({ where: { id: company.id }, data: { tags: merged } });
      }
    }
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Company",
    entityId: companyIds[0],
    entityLabel: `Bulk updated ${companyIds.length} company/companies`,
  });
  for (const path of ["/companies", "/customers", "/vendors", "/commission-parties", "/resellers"]) {
    revalidatePath(path);
  }
  return { ok: true, data: { count: companyIds.length } };
}

/**
 * How many vendor-type companies are still onboarding, across the whole filtered set rather than
 * the current page — a header badge that only counted the visible rows would drop as you paged.
 */
export async function countVendorsOnboarding(params?: VendorListParams) {
  const user = await requireUser();
  // Scoped to match `listVendorsPaged`, or the badge would advertise a number of vendors larger
  // than the list underneath it can account for.
  return db.company.count({
    where: { ...vendorListWhere(params, await companyCustomSearch(user.id, params?.search)), ...(await companyScope(user.id)), vendorStatus: "ONBOARDING" },
  });
}
