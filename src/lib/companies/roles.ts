import { cache } from "react";
import type { CompanyRelationshipType, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { assignVendorCodes } from "@/lib/companies/vendor-code";
import { customerRelationshipTypeValues, isCustomerRelationshipType, isVendorRelationshipType, vendorRelationshipTypeValues } from "@/lib/validation/company";

/**
 * One company, two roles (owner, 19 Oct 2026): a vendor who also buys from us, or a customer we also
 * buy from. The company keeps its main kind (`relationshipType`) and gets the other side as a role —
 * `alsoCustomer` or `alsoVendor` — with `sideOwnerUserId` looking after that side: the vendor manager of a
 * customer that's also a vendor, the account manager of a vendor that's also a customer. One record, so
 * one set of contacts, addresses and GSTIN, in both lists and both sides' pickers.
 *
 * Everything that asks "is this a customer?" or "is this a vendor?" asks here, not of the kind alone. A
 * workspace not migrated to 20261119100000_company_two_roles yet has every company its one kind.
 */

const CUSTOMER_KINDS = [...customerRelationshipTypeValues] as CompanyRelationshipType[];
const VENDOR_KINDS = [...vendorRelationshipTypeValues] as CompanyRelationshipType[];

export type CompanySide = "customer" | "vendor";

/** Whether this workspace has the columns yet — asked before a query filters on them; once a request. */
export const twoRolesHere = cache(async (): Promise<boolean> => {
  try {
    await db.company.findFirst({ select: { alsoCustomer: true }, take: 1 });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
});

/**
 * Whether any company here has a second role yet — the access rule adds its branches only then, so a
 * workspace without one keeps the query it always had. Once a request.
 */
export const twoRolesInUse = cache(async (): Promise<boolean> => {
  if (!(await twoRolesHere())) return false;
  return !!(await db.company.findFirst({ where: { OR: [{ alsoCustomer: true }, { alsoVendor: true }] }, select: { id: true } }));
});

/** Companies on the customer side: a client or a reseller, or anything that's also a customer. */
export async function customerSide(): Promise<Prisma.CompanyWhereInput> {
  const kinds = { relationshipType: { in: CUSTOMER_KINDS } };
  return (await twoRolesHere()) ? { OR: [kinds, { alsoCustomer: true }] } : kinds;
}

/** Companies on the vendor side: the vendor family, or anything that's also a vendor. */
export async function vendorSide(): Promise<Prisma.CompanyWhereInput> {
  const kinds = { relationshipType: { in: VENDOR_KINDS } };
  return (await twoRolesHere()) ? { OR: [kinds, { alsoVendor: true }] } : kinds;
}

/** The Companies module's own: clients, and any company that's also a customer — a vendor who buys from us. */
export async function clientSide(): Promise<Prisma.CompanyWhereInput> {
  const clients = { relationshipType: "CLIENT" as const };
  return (await twoRolesHere()) ? { OR: [clients, { alsoCustomer: true }] } : clients;
}

/** Some vendor kinds — distributors and OEMs, say — and any company that is also a vendor, whose kind of vendor isn't said. */
export async function vendorKindsSide(kinds: CompanyRelationshipType[]): Promise<Prisma.CompanyWhereInput> {
  const of = { relationshipType: { in: kinds } };
  return (await twoRolesHere()) ? { OR: [of, { alsoVendor: true }] } : of;
}

/** A vendor list narrowed to one kind still shows that kind only; the whole list takes in the vendors added as a role. */
export async function vendorListSide(kind?: CompanyRelationshipType): Promise<Prisma.CompanyWhereInput> {
  if (kind) return { relationshipType: kind };
  return vendorSide();
}

export type CompanyRoles = {
  customer: boolean;
  vendor: boolean;
  /** The side added to the main kind, if any. */
  added: CompanySide | null;
  sideOwnerUserId: string | null;
};

type RoleFacts = {
  id?: string;
  relationshipType: CompanyRelationshipType;
  alsoCustomer?: boolean;
  alsoVendor?: boolean;
  sideOwnerUserId?: string | null;
};

/** The roles of one company: from the facts given, its flags looked up by id when they weren't. */
export async function rolesOf(company: RoleFacts): Promise<CompanyRoles> {
  let { alsoCustomer, alsoVendor, sideOwnerUserId } = company;
  if ((alsoCustomer === undefined || alsoVendor === undefined) && company.id) {
    try {
      const row = await db.company.findUnique({ where: { id: company.id }, select: { alsoCustomer: true, alsoVendor: true, sideOwnerUserId: true } });
      alsoCustomer = row?.alsoCustomer ?? false;
      alsoVendor = row?.alsoVendor ?? false;
      sideOwnerUserId = row?.sideOwnerUserId ?? null;
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  const mainCustomer = isCustomerRelationshipType(company.relationshipType);
  const mainVendor = isVendorRelationshipType(company.relationshipType);
  const addedCustomer = !mainCustomer && alsoCustomer === true;
  const addedVendor = !mainVendor && alsoVendor === true;
  return {
    customer: mainCustomer || addedCustomer,
    vendor: mainVendor || addedVendor,
    added: addedCustomer ? "customer" : addedVendor ? "vendor" : null,
    sideOwnerUserId: addedCustomer || addedVendor ? (sideOwnerUserId ?? null) : null,
  };
}

/** Whether a company is a customer — by its kind, or as a role. Asks the database only when the kind says no. */
export async function isCustomerSide(company: RoleFacts): Promise<boolean> {
  if (isCustomerRelationshipType(company.relationshipType)) return true;
  return (await rolesOf(company)).customer;
}

/** Whether a company is a vendor — by its kind, or as a role. */
export async function isVendorSide(company: RoleFacts): Promise<boolean> {
  if (isVendorRelationshipType(company.relationshipType)) return true;
  return (await rolesOf(company)).vendor;
}

/** Which side a kind is on — what its main role is, for the role that may be added to it. */
export function mainSide(kind: CompanyRelationshipType): CompanySide | null {
  return isCustomerRelationshipType(kind) ? "customer" : isVendorRelationshipType(kind) ? "vendor" : null;
}

/** The role a company of this kind may take on: the side it isn't on already. A commission party may take either. */
export function rolesAddable(kind: CompanyRelationshipType): CompanySide[] {
  const main = mainSide(kind);
  if (main === "customer") return ["vendor"];
  if (main === "vendor") return ["customer"];
  return ["customer", "vendor"];
}

export type RoleChange = { ok: true } | { ok: false; error: string };

/**
 * Adds or takes off the role a company has besides its main kind. One added role at most, and never on a
 * reseller's end customer — the reseller is who we deal with. A vendor role starts it onboarding and
 * gives it a vendor code, as a new vendor gets. Taking a role off leaves what was done under it — its bills
 * and orders stay; it's just no longer offered as that side.
 */
export async function setCompanyRole(companyId: string, side: CompanySide, on: boolean): Promise<RoleChange> {
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { relationshipType: true, managedByResellerId: true, vendorStatus: true, alsoCustomer: true, alsoVendor: true },
  });
  if (!company) return { ok: false, error: "That company isn't there any more." };
  if (!on) {
    await db.company.update({ where: { id: companyId }, data: side === "customer" ? { alsoCustomer: false, sideOwnerUserId: null } : { alsoVendor: false, sideOwnerUserId: null }, select: { id: true } });
    return { ok: true };
  }
  if (company.managedByResellerId) return { ok: false, error: "A reseller's customer is theirs to deal with, so it can't be a vendor of ours too." };
  if (!rolesAddable(company.relationshipType).includes(side)) return { ok: false, error: `It's a ${side} already.` };
  const other = side === "customer" ? company.alsoVendor : company.alsoCustomer;
  if (other) return { ok: false, error: "It has a second role already." };
  if (side === "customer") {
    await db.company.update({ where: { id: companyId }, data: { alsoCustomer: true }, select: { id: true } });
  } else {
    await db.company.update({ where: { id: companyId }, data: { alsoVendor: true, vendorStatus: company.vendorStatus ?? "ONBOARDING" }, select: { id: true } });
    await assignVendorCodes([companyId]);
  }
  return { ok: true };
}

/** Who looks after the added side; null for nobody in particular. The caller checks the person may be given it. */
export async function setSideOwner(companyId: string, userId: string | null): Promise<void> {
  await db.company.update({ where: { id: companyId }, data: { sideOwnerUserId: userId }, select: { id: true } });
}
