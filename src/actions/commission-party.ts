"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { commissionPartyAccountSchema } from "@/lib/validation/commission-party";
import type { ActionResult } from "@/actions/company";

/** The customer companies a commission party is linked to (referral source) — shown on the commission party's own page. */
export async function listLinkedCompanies(commissionPartyId: string) {
  await requireModuleUser("commission_parties");
  const links = await db.commissionPartyLink.findMany({
    where: { commissionPartyId },
    orderBy: { createdAt: "desc" },
    include: { company: { select: { id: true, name: true, relationshipType: true } } },
  });
  return links.map((l) => ({ linkId: l.id, ...l.company }));
}

export async function linkCommissionPartyToCompany(commissionPartyId: string, companyId: string): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("commission_parties");
  const [commissionParty, company] = await Promise.all([
    db.company.findUnique({ where: { id: commissionPartyId } }),
    db.company.findUnique({ where: { id: companyId } }),
  ]);
  if (!commissionParty || commissionParty.relationshipType !== "COMMISSION_PARTY") {
    return { ok: false, error: "Not a commission party." };
  }
  if (!company) {
    return { ok: false, error: "Company not found." };
  }
  // A link records who refers business from a customer, so the other side has to be one — this also
  // rules out linking a party to itself or to another vendor/commission party.
  if (company.relationshipType !== "CLIENT") {
    return { ok: false, error: "A commission party can only be linked to a customer company." };
  }

  try {
    const link = await db.commissionPartyLink.create({ data: { commissionPartyId, companyId } });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "Company",
      entityId: commissionPartyId,
      entityLabel: `Linked ${commissionParty.name} to ${company.name}`,
    });

    revalidatePath(`/companies/${commissionPartyId}`);
    return { ok: true, data: { id: link.id } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: `Already linked to ${company.name}.` };
    }
    throw err;
  }
}

export async function unlinkCommissionPartyFromCompany(linkId: string): Promise<ActionResult<null>> {
  await requireModuleUser("commission_parties");
  const link = await db.commissionPartyLink.findUnique({ where: { id: linkId } });
  if (!link) {
    return { ok: false, error: "Link not found." };
  }
  await db.commissionPartyLink.delete({ where: { id: linkId } });

  revalidatePath(`/companies/${link.commissionPartyId}`);
  return { ok: true, data: null };
}

/** A commission party's payee accounts (related parties) — label, PAN, bank, UPI — for both display and the order-expense "pay into account" picker. */
export async function listCommissionPartyAccounts(commissionPartyId: string) {
  await requireModuleUser("commission_parties");
  return db.commissionPartyAccount.findMany({
    where: { commissionPartyId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

export async function createCommissionPartyAccount(commissionPartyId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("commission_parties");
  const parsed = commissionPartyAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const commissionParty = await db.company.findUnique({ where: { id: commissionPartyId } });
  if (!commissionParty || commissionParty.relationshipType !== "COMMISSION_PARTY") {
    return { ok: false, error: "Not a commission party." };
  }

  const data = parsed.data;
  const account = await db.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.commissionPartyAccount.updateMany({ where: { commissionPartyId }, data: { isDefault: false } });
    }
    return tx.commissionPartyAccount.create({
      data: {
        commissionPartyId,
        label: data.label.trim(),
        accountHolderName: data.accountHolderName || null,
        panNumber: data.panNumber || null,
        bankAccountNumber: data.bankAccountNumber || null,
        bankIfsc: data.bankIfsc || null,
        bankName: data.bankName || null,
        upiId: data.upiId || null,
        isDefault: data.isDefault,
      },
    });
  });

  await recordAudit({ userId: user.id, action: "CREATE", entityType: "CommissionPartyAccount", entityId: account.id, entityLabel: `${account.label} (${commissionParty.name})` });

  revalidatePath(`/companies/${commissionPartyId}`);
  return { ok: true, data: { id: account.id } };
}

export async function updateCommissionPartyAccount(id: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("commission_parties");
  const parsed = commissionPartyAccountSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const existing = await db.commissionPartyAccount.findUnique({ where: { id } });
  if (!existing) {
    return { ok: false, error: "Account not found." };
  }

  const data = parsed.data;
  await db.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.commissionPartyAccount.updateMany({
        where: { commissionPartyId: existing.commissionPartyId, id: { not: id } },
        data: { isDefault: false },
      });
    }
    await tx.commissionPartyAccount.update({
      where: { id },
      data: {
        label: data.label.trim(),
        accountHolderName: data.accountHolderName || null,
        panNumber: data.panNumber || null,
        bankAccountNumber: data.bankAccountNumber || null,
        bankIfsc: data.bankIfsc || null,
        bankName: data.bankName || null,
        upiId: data.upiId || null,
        isDefault: data.isDefault,
      },
    });
  });

  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CommissionPartyAccount", entityId: id, entityLabel: data.label });

  revalidatePath(`/companies/${existing.commissionPartyId}`);
  return { ok: true, data: { id } };
}

export async function deleteCommissionPartyAccount(id: string): Promise<ActionResult<null>> {
  await requireModuleUser("commission_parties");
  const existing = await db.commissionPartyAccount.findUnique({ where: { id } });
  if (!existing) {
    return { ok: false, error: "Account not found." };
  }
  // The expense FK is ON DELETE SET NULL, so deleting an account that's been paid into would
  // silently strip the account off those orders. Same rule as deleting a location with orders.
  const paidExpenses = await db.orderExpense.count({ where: { payeeAccountId: id } });
  if (paidExpenses > 0) {
    return {
      ok: false,
      error: `This account is recorded on ${paidExpenses} order expense(s) and can't be deleted — it would erase how those commissions were paid.`,
    };
  }
  await db.commissionPartyAccount.delete({ where: { id } });

  revalidatePath(`/companies/${existing.commissionPartyId}`);
  return { ok: true, data: null };
}

/**
 * The mirror of `listLinkedCompanies`: the commission parties who refer business from this customer,
 * shown on the *customer's* page. The link is the same row read from the other end — a customer's
 * 360 view should show who gets paid on their deals without having to open every commission party.
 */
export async function listCompanyCommissionParties(companyId: string) {
  await requireModuleUser("commission_parties");
  const links = await db.commissionPartyLink.findMany({
    where: { companyId },
    orderBy: { createdAt: "desc" },
    include: { commissionParty: { select: { id: true, name: true, vendorStatus: true } } },
  });
  return links.map((l) => ({ linkId: l.id, ...l.commissionParty }));
}

/** Commission parties available to link, for the picker on a customer's page. */
export async function listCommissionPartyOptions() {
  await requireModuleUser("commission_parties");
  return db.company.findMany({
    where: { relationshipType: "COMMISSION_PARTY" },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

/**
 * Commission actually paid out on this company's orders — the money side of the link, as opposed to
 * the relationship. Read from the customer's end, so `companyProduct.companyId` is the filter.
 */
export async function listCompanyCommissions(companyId: string) {
  await requireModuleUser("commission_parties");
  const rows = await db.orderExpense.findMany({
    where: { type: "COMMISSION", companyProduct: { companyId } },
    orderBy: { createdAt: "desc" },
    include: {
      payee: { select: { id: true, name: true } },
      payeeAccount: { select: { id: true, label: true, bankName: true, upiId: true } },
      companyProduct: {
        select: { id: true, orderSeq: true, createdAt: true, item: { select: { name: true } } },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    notes: row.notes,
    createdAt: row.createdAt,
    payee: row.payee,
    payeeAccount: row.payeeAccount,
    order: {
      id: row.companyProduct.id,
      orderSeq: row.companyProduct.orderSeq,
      itemName: row.companyProduct.item.name,
      createdAt: row.companyProduct.createdAt,
    },
  }));
}

/**
 * The same expense rows read from the commission party's end — what this party has earned, and
 * which customer each payout came from.
 */
export async function listCommissionPartyEarnings(commissionPartyId: string) {
  await requireModuleUser("commission_parties");
  const rows = await db.orderExpense.findMany({
    where: { type: "COMMISSION", payeeCompanyId: commissionPartyId },
    orderBy: { createdAt: "desc" },
    include: {
      payeeAccount: { select: { id: true, label: true } },
      companyProduct: {
        select: {
          id: true,
          orderSeq: true,
          createdAt: true,
          item: { select: { name: true } },
          company: { select: { id: true, name: true } },
        },
      },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    notes: row.notes,
    createdAt: row.createdAt,
    payeeAccount: row.payeeAccount,
    order: {
      id: row.companyProduct.id,
      orderSeq: row.companyProduct.orderSeq,
      itemName: row.companyProduct.item.name,
      company: row.companyProduct.company,
    },
  }));
}
