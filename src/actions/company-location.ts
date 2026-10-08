"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { requireUser } from "@/lib/session";
import {
  addCompanyLocationSchema,
  updateCompanyLocationSchema,
  type AddCompanyLocationInput,
} from "@/lib/validation/company-location";
import type { ActionResult } from "@/actions/company";

function locationScalarData(input: Omit<AddCompanyLocationInput, "companyId">) {
  return {
    label: input.label.trim(),
    address: input.address || null,
    city: input.city || null,
    state: input.state || null,
    country: input.country || null,
    pincode: input.pincode || null,
    gstNumber: input.gstNumber || null,
    gstTreatment: input.gstTreatment,
    isBilling: input.isBilling,
    isShipping: input.isShipping,
  };
}

/**
 * Lightweight location list for the order-punch "which location is this order for" picker.
 *
 * Guarded rather than filtered: the caller names the company, so a `where` on the scope would
 * narrow nothing. Reached as a server action with whatever id is passed, it handed back any
 * account's office labels and which of them are billing and shipping addresses.
 */
export async function listCompanyLocationOptions(companyId: string) {
  const user = await requireUser();

  const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) return [];

  return db.companyLocation.findMany({
    where: { companyId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { id: true, label: true, isPrimary: true, isBilling: true, isShipping: true },
  });
}

export async function addCompanyLocation(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  const parsed = addCompanyLocationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { companyId, ...fields } = parsed.data;

  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) {
    return { ok: false, error: "Company not found." };
  }

  const location = await db.companyLocation.create({
    data: { companyId, ...locationScalarData(fields), isPrimary: false },
  });

  revalidatePath(`/companies/${companyId}`);
  return { ok: true, data: { id: location.id } };
}

export async function updateCompanyLocation(input: unknown): Promise<ActionResult<{ id: string }>> {
  await requireUser();
  const parsed = updateCompanyLocationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;

  const location = await db.companyLocation.findUnique({ where: { id } });
  if (!location) {
    return { ok: false, error: "Location not found." };
  }

  await db.companyLocation.update({
    where: { id },
    data: locationScalarData(fields),
  });

  revalidatePath(`/companies/${location.companyId}`);
  return { ok: true, data: { id } };
}

export async function setPrimaryLocation(id: string): Promise<ActionResult<null>> {
  await requireUser();
  const location = await db.companyLocation.findUnique({ where: { id } });
  if (!location) {
    return { ok: false, error: "Location not found." };
  }

  await db.$transaction(async (tx) => {
    await tx.companyLocation.updateMany({ where: { companyId: location.companyId }, data: { isPrimary: false } });
    await tx.companyLocation.update({ where: { id }, data: { isPrimary: true } });
  });

  revalidatePath(`/companies/${location.companyId}`);
  return { ok: true, data: null };
}

export async function deleteCompanyLocation(id: string): Promise<ActionResult<null>> {
  await requireUser();
  const location = await db.companyLocation.findUnique({ where: { id } });
  if (!location) {
    return { ok: false, error: "Location not found." };
  }

  const totalLocations = await db.companyLocation.count({ where: { companyId: location.companyId } });
  if (totalLocations <= 1) {
    return { ok: false, error: "A company must have at least one location." };
  }

  try {
    await db.companyLocation.delete({ where: { id } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return { ok: false, error: "This location has orders attached to it and can't be deleted." };
    }
    throw err;
  }

  if (location.isPrimary) {
    const nextPrimary = await db.companyLocation.findFirst({
      where: { companyId: location.companyId },
      orderBy: { createdAt: "asc" },
    });
    if (nextPrimary) {
      await db.companyLocation.update({ where: { id: nextPrimary.id }, data: { isPrimary: true } });
    }
  }

  revalidatePath(`/companies/${location.companyId}`);
  return { ok: true, data: null };
}
