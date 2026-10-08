"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { bankAccountData, bankAccountSchema } from "@/lib/validation/bank-account";

/**
 * The organisation's own bank accounts (owner, 8 Oct 2026) — Settings › Organisation. One is the
 * primary, printed on sales documents unless the branch's default or the document names another
 * (src/lib/banking/organisation-accounts.ts). Changed with `settings.manage`, like the rest of the
 * letterhead. An account a document or branch names is retired, not deleted: a reprint of an old
 * invoice must still show where it asked to be paid.
 */

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type OrganisationBankAccountRow = {
  id: string;
  label: string;
  accountHolderName: string | null;
  bankName: string | null;
  branchName: string | null;
  accountNumber: string | null;
  ifsc: string | null;
  swift: string | null;
  upiId: string | null;
  isPrimary: boolean;
  active: boolean;
  /** Documents that name it and branches that default to it — either means it is retired, not deleted. */
  documents: number;
  branches: string[];
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
  active: true,
  _count: { select: { documents: true } },
  branches: { select: { name: true }, orderBy: { name: "asc" } },
} satisfies Prisma.OrganisationBankAccountSelect;

const NO_RIGHT = "You can't change organisation settings.";

async function manager() {
  const user = await requireUser();
  return (await hasEffectivePermission(user.id, "settings.manage")) ? user : null;
}

function refresh() {
  revalidatePath("/settings/organisation");
  revalidatePath("/settings/branches");
}

const lastFour = (n: string | null | undefined) => (n ? `•••• ${n.slice(-4)}` : "no number");

export async function listOrganisationBankAccounts(): Promise<OrganisationBankAccountRow[] | null> {
  if (!(await manager())) return null;
  const rows = await db.organisationBankAccount.findMany({
    select: SELECT,
    orderBy: [{ isPrimary: "desc" }, { active: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(({ _count, branches, ...r }) => ({ ...r, documents: _count.documents, branches: branches.map((b) => b.name) }));
}

export async function createOrganisationBankAccount(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };

  const created = await db.$transaction(async (tx) => {
    // The first account in use is the primary whatever the box said.
    const first = (await tx.organisationBankAccount.count({ where: { active: true } })) === 0;
    const primary = first || parsed.data.isPrimary;
    if (primary) await tx.organisationBankAccount.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
    return tx.organisationBankAccount.create({ data: { ...bankAccountData(parsed.data), isPrimary: primary }, select: { id: true } });
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "OrganisationBankAccount", entityId: created.id, entityLabel: `${parsed.data.label} (${lastFour(parsed.data.accountNumber)})` });
  refresh();
  return { ok: true, data: created };
}

export async function updateOrganisationBankAccount(id: string, input: unknown): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const parsed = bankAccountSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const current = await db.organisationBankAccount.findUnique({ where: { id }, select: { isPrimary: true, active: true, accountNumber: true } });
  if (!current) return { ok: false, error: "That account isn't there any more." };
  if (parsed.data.isPrimary && !current.active) return { ok: false, error: "Put the account back in use before making it the primary." };

  await db.$transaction(async (tx) => {
    // Unticking the primary does nothing by itself — making another the primary is how it moves.
    if (parsed.data.isPrimary && !current.isPrimary) await tx.organisationBankAccount.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
    await tx.organisationBankAccount.update({ where: { id }, data: { ...bankAccountData(parsed.data), isPrimary: current.isPrimary || parsed.data.isPrimary } });
  });
  const numberChanged = (parsed.data.accountNumber || null) !== current.accountNumber;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "OrganisationBankAccount",
    entityId: id,
    entityLabel: numberChanged ? `${parsed.data.label}: account number ${lastFour(current.accountNumber)} → ${lastFour(parsed.data.accountNumber)}` : parsed.data.label,
  });
  refresh();
  return { ok: true, data: null };
}

export async function setPrimaryOrganisationBankAccount(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const account = await db.organisationBankAccount.findUnique({ where: { id }, select: { label: true, isPrimary: true, active: true } });
  if (!account) return { ok: false, error: "That account isn't there any more." };
  if (!account.active) return { ok: false, error: "Put the account back in use before making it the primary." };
  if (!account.isPrimary) {
    await db.$transaction(async (tx) => {
      await tx.organisationBankAccount.updateMany({ where: { isPrimary: true }, data: { isPrimary: false } });
      await tx.organisationBankAccount.update({ where: { id }, data: { isPrimary: true } });
    });
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationBankAccount", entityId: id, entityLabel: `${account.label} made primary` });
  }
  refresh();
  return { ok: true, data: null };
}

/** Retired (out of the pickers, never printed by default) or back in use. The primary is not retired. */
export async function setOrganisationBankAccountActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const account = await db.organisationBankAccount.findUnique({ where: { id }, select: { label: true, isPrimary: true } });
  if (!account) return { ok: false, error: "That account isn't there any more." };
  if (!active && account.isPrimary) return { ok: false, error: "Make another account the primary before retiring this one." };
  await db.organisationBankAccount.update({ where: { id }, data: { active } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "OrganisationBankAccount", entityId: id, entityLabel: `${account.label} ${active ? "back in use" : "retired"}` });
  refresh();
  return { ok: true, data: null };
}

/** Only an account nothing names. One a document or branch names is retired instead. */
export async function deleteOrganisationBankAccount(id: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: NO_RIGHT };
  const account = await db.organisationBankAccount.findUnique({
    where: { id },
    select: { label: true, isPrimary: true, accountNumber: true, _count: { select: { documents: true, branches: true } } },
  });
  if (!account) return { ok: false, error: "That account isn't there any more." };
  if (account._count.documents > 0 || account._count.branches > 0) {
    return { ok: false, error: "Documents or branches name this account, so it can't be deleted — retire it instead." };
  }
  const others = await db.organisationBankAccount.count({ where: { id: { not: id }, active: true } });
  if (account.isPrimary && others > 0) return { ok: false, error: "Make another account the primary before deleting this one." };
  await db.organisationBankAccount.delete({ where: { id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "OrganisationBankAccount", entityId: id, entityLabel: `${account.label} (${lastFour(account.accountNumber)})` });
  refresh();
  return { ok: true, data: null };
}
