"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { companyPath } from "@/lib/record-links";
import { bankAccountData, bankAccountSchema, maskedAccountNumber } from "@/lib/validation/bank-account";
import { holdsBankAccounts } from "@/lib/validation/company";

/**
 * The bank accounts a company we pay is paid into (owner, 8 Oct 2026) — several per vendor, one of
 * them primary. Seen by whoever sees the company; the numbers in full, and every change, only with
 * `payments.manage`, because rewriting a vendor's account number is how payment fraud is done. Each
 * change is audited with the account's last four digits, never the whole number.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type CompanyBankAccountRow = {
  id: string;
  label: string;
  accountHolderName: string | null;
  bankName: string | null;
  branchName: string | null;
  /** In full with `payments.manage` or `payments.record`; otherwise its last four. */
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  upiId: string | null;
  isPrimary: boolean;
};

const SELECT = {
  id: true,
  label: true,
  accountHolderName: true,
  bankName: true,
  branchName: true,
  accountNumber: true,
  ifsc: true,
  swift: true,
  upiId: true,
  isPrimary: true,
} satisfies Prisma.CompanyBankAccountSelect;

const NOT_HERE = "Company not found.";
const NOT_A_PAYEE = "Only vendors, OEMs, distributors, partners and resellers keep bank accounts here.";
const NO_RIGHT = "Changing a company's bank accounts needs the “Manage finance records” permission.";

/** The company, if this person can see it and it is one we pay. */
async function payee(userId: string, companyId: string): Promise<{ ok: true; id: string; name: string; seq: number } | { ok: false; error: string }> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, companySeq: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(userId, company))) return { ok: false, error: NOT_HERE };
  if (!holdsBankAccounts(company.relationshipType)) return { ok: false, error: NOT_A_PAYEE };
  return { ok: true, id: company.id, name: company.name, seq: company.companySeq };
}

/** The account and its company, for a change — refused without the right, or out of this person's sight. */
async function forChange(accountId: string) {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "payments.manage"))) return { ok: false as const, error: NO_RIGHT };
  const account = await db.companyBankAccount.findUnique({ where: { id: accountId }, select: { ...SELECT, companyId: true } });
  if (!account) return { ok: false as const, error: "That account isn't there any more." };
  const company = await payee(user.id, account.companyId);
  if (!company.ok) return company;
  return { ok: true as const, user, account, company };
}

function refresh(companySeq: number) {
  revalidatePath(companyPath(companySeq));
  revalidatePath("/vendors");
}

const lastFour = (n: string | null | undefined) => (n ? `•••• ${n.slice(-4)}` : "no number");

export async function listCompanyBankAccounts(
  companyId: string,
): Promise<ActionResult<{ accounts: CompanyBankAccountRow[]; canManage: boolean }>> {
  const user = await requireUser();
  const company = await payee(user.id, companyId);
  if (!company.ok) return company;
  const [rows, canManage, records] = await Promise.all([
    db.companyBankAccount.findMany({ where: { companyId }, select: SELECT, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] }),
    hasEffectivePermission(user.id, "payments.manage"),
    hasEffectivePermission(user.id, "payments.record"),
  ]);
  const seesNumbers = canManage || records;
  return {
    ok: true,
    data: { accounts: rows.map((r) => (seesNumbers ? r : { ...r, accountNumber: maskedAccountNumber(r.accountNumber) })), canManage },
  };
}

export async function createCompanyBankAccount(companyId: string, input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "payments.manage"))) return { ok: false, error: NO_RIGHT };
  const company = await payee(user.id, companyId);
  if (!company.ok) return company;
  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const created = await db.$transaction(async (tx) => {
    // The first account is the primary whatever the box said; a later one only when asked.
    const first = (await tx.companyBankAccount.count({ where: { companyId } })) === 0;
    const primary = first || parsed.data.isPrimary;
    if (primary) await tx.companyBankAccount.updateMany({ where: { companyId, isPrimary: true }, data: { isPrimary: false } });
    return tx.companyBankAccount.create({ data: { companyId, ...bankAccountData(parsed.data), isPrimary: primary }, select: { id: true } });
  });
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CompanyBankAccount",
    entityId: created.id,
    entityLabel: `${company.name} — ${parsed.data.label} (${lastFour(parsed.data.accountNumber)})`,
  });
  refresh(company.seq);
  return { ok: true, data: created };
}

export async function updateCompanyBankAccount(accountId: string, input: unknown): Promise<ActionResult<null>> {
  const found = await forChange(accountId);
  if (!found.ok) return found;
  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { user, account, company } = found;

  await db.$transaction(async (tx) => {
    // Unticking the primary does nothing by itself: some account is always the primary while there are
    // any. Making another one primary is how it moves.
    if (parsed.data.isPrimary && !account.isPrimary) {
      await tx.companyBankAccount.updateMany({ where: { companyId: account.companyId, isPrimary: true }, data: { isPrimary: false } });
    }
    await tx.companyBankAccount.update({
      where: { id: accountId },
      data: { ...bankAccountData(parsed.data), isPrimary: account.isPrimary || parsed.data.isPrimary },
    });
  });
  const numberChanged = (parsed.data.accountNumber || null) !== account.accountNumber;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CompanyBankAccount",
    entityId: accountId,
    entityLabel: numberChanged
      ? `${company.name} — ${parsed.data.label}: account number ${lastFour(account.accountNumber)} → ${lastFour(parsed.data.accountNumber)}`
      : `${company.name} — ${parsed.data.label}`,
  });
  refresh(company.seq);
  return { ok: true, data: null };
}

export async function setPrimaryCompanyBankAccount(accountId: string): Promise<ActionResult<null>> {
  const found = await forChange(accountId);
  if (!found.ok) return found;
  const { user, account, company } = found;
  if (!account.isPrimary) {
    await db.$transaction(async (tx) => {
      await tx.companyBankAccount.updateMany({ where: { companyId: account.companyId, isPrimary: true }, data: { isPrimary: false } });
      await tx.companyBankAccount.update({ where: { id: accountId }, data: { isPrimary: true } });
    });
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "CompanyBankAccount",
      entityId: accountId,
      entityLabel: `${company.name} — ${account.label} (${lastFour(account.accountNumber)}) made primary`,
    });
  }
  refresh(company.seq);
  return { ok: true, data: null };
}

export async function deleteCompanyBankAccount(accountId: string): Promise<ActionResult<null>> {
  const found = await forChange(accountId);
  if (!found.ok) return found;
  const { user, account, company } = found;

  await db.$transaction(async (tx) => {
    await tx.companyBankAccount.delete({ where: { id: accountId } });
    // The primary gone, the oldest of the rest takes its place — a vendor with accounts has a primary.
    if (account.isPrimary) {
      const next = await tx.companyBankAccount.findFirst({ where: { companyId: account.companyId }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (next) await tx.companyBankAccount.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "CompanyBankAccount",
    entityId: accountId,
    entityLabel: `${company.name} — ${account.label} (${lastFour(account.accountNumber)})`,
  });
  refresh(company.seq);
  return { ok: true, data: null };
}
