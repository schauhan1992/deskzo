"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { entryTotals, hasOneSidedLines, isBalanced } from "@/lib/ledger/posting";
import { ensureChartOfAccounts, reversedLines, reversibleLineSelect, writeEntry } from "@/lib/ledger/journal";
import type { ActionResult } from "@/actions/company";

/**
 * Reverses an entry with an equal and opposite one.
 *
 * Nothing is edited or deleted — a ledger whose history can be rewritten is not a ledger, and the
 * reversal is itself a dated transaction, which is what an auditor needs to see.
 */
export async function reverseJournalEntry(input: {
  entryId: string;
  date?: Date;
  reason?: string;
}): Promise<ActionResult<{ id: string; entryNumber: string }>> {
  const user = await requireModuleUser("accounting");
  if (!(await hasEffectivePermission(user.id, "ledger.post"))) {
    return { ok: false, error: "You can't reverse a ledger entry." };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      const original = await tx.journalEntry.findUnique({
        where: { id: input.entryId },
        select: {
          id: true, entryNumber: true, date: true, narration: true, companyId: true,
          reversedBy: { select: { id: true, entryNumber: true } },
          lines: { select: reversibleLineSelect, orderBy: { sortOrder: "asc" } },
        },
      });
      if (!original) throw new Error("That entry no longer exists.");
      if (original.reversedBy) throw new Error(`Already reversed by ${original.reversedBy.entryNumber}.`);

      // Branch, GSTIN and cost centre go with each line, so the reversal lands where the original did.
      const flipped = reversedLines(original.lines);

      return writeEntry(tx, {
        // Reversing into a closed period would change a figure someone has already filed, so the
        // reversal is dated today unless the caller deliberately says otherwise.
        date: input.date ?? new Date(),
        narration: `Reversal of ${original.entryNumber}${input.reason ? ` — ${input.reason}` : ""}`,
        source: "MANUAL",
        userId: user.id,
        lines: flipped,
        companyId: original.companyId,
        reversesId: original.id,
      });
    });

    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "JournalEntry",
      entityId: result.id,
      entityLabel: `Reversed ${input.entryId}`,
    });
    revalidatePath("/accounting/journal");
    return { ok: true, data: result };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reverse that entry." };
  }
}

/** The GST accounts, whose lines belong to one GSTIN's return (spec §8.3). */
const GST_ACCOUNT_KEYS: string[] = [
  SYSTEM_ACCOUNTS.INPUT_CGST,
  SYSTEM_ACCOUNTS.INPUT_SGST,
  SYSTEM_ACCOUNTS.INPUT_IGST,
  SYSTEM_ACCOUNTS.OUTPUT_CGST,
  SYSTEM_ACCOUNTS.OUTPUT_SGST,
  SYSTEM_ACCOUNTS.OUTPUT_IGST,
];

/**
 * A hand-written entry — opening balances, depreciation, a correction the documents can't express.
 *
 * Each line may name a branch and a GST registration. A branch is optional (none means the line is
 * not attributed to one). A line on a GST account must say which GSTIN it belongs to once there is more
 * than one — otherwise it would sit in no return, or in the wrong one; with exactly one it takes that
 * one, and with none it stays blank, as every line did before registrations existed.
 */
export async function createManualJournal(input: {
  date: string;
  narration: string;
  source?: "MANUAL" | "OPENING";
  lines: {
    accountId: string;
    debit: string;
    credit: string;
    companyId?: string;
    narration?: string;
    branchId?: string;
    gstRegistrationId?: string;
  }[];
}): Promise<ActionResult<{ id: string; entryNumber: string }>> {
  const user = await requireModuleUser("accounting");
  if (!(await hasEffectivePermission(user.id, "ledger.post"))) {
    return { ok: false, error: "You can't write a journal entry." };
  }

  const narration = input.narration?.trim();
  if (!narration) return { ok: false, error: "Every entry needs a narration — it's what makes the books readable later." };
  if (!input.date) return { ok: false, error: "Pick a date." };

  const lines = input.lines
    .map((l) => ({
      accountId: l.accountId,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      companyId: l.companyId || null,
      narration: l.narration?.trim() || null,
      branchId: l.branchId || null,
      gstRegistrationId: l.gstRegistrationId || null,
    }))
    .filter((l) => l.accountId && (l.debit !== 0 || l.credit !== 0));

  if (lines.length < 2) return { ok: false, error: "An entry needs at least two lines with an amount." };
  if (!hasOneSidedLines(lines)) return { ok: false, error: "A line carries either a debit or a credit, not both." };
  if (!isBalanced(lines)) {
    const { debit, credit } = entryTotals(lines);
    return { ok: false, error: `Debits are ${debit.toFixed(2)} and credits are ${credit.toFixed(2)} — they must match.` };
  }

  const groups = await db.ledgerAccount.findMany({
    where: { id: { in: lines.map((l) => l.accountId) }, OR: [{ isGroup: true }, { active: false }] },
    select: { name: true, isGroup: true },
  });
  if (groups.length > 0) {
    const g = groups[0];
    return {
      ok: false,
      error: g.isGroup
        ? `${g.name} is a group — post to one of the accounts under it.`
        : `${g.name} is archived and can't take new entries.`,
    };
  }

  const branchIds = [...new Set(lines.flatMap((l) => (l.branchId ? [l.branchId] : [])))];
  const registrationIds = [...new Set(lines.flatMap((l) => (l.gstRegistrationId ? [l.gstRegistrationId] : [])))];
  const [knownBranches, knownRegistrations, gstAccounts, activeRegistrations] = await Promise.all([
    branchIds.length ? db.branch.count({ where: { id: { in: branchIds }, active: true } }) : 0,
    registrationIds.length ? db.gstRegistration.count({ where: { id: { in: registrationIds }, active: true } }) : 0,
    db.ledgerAccount.findMany({
      where: { id: { in: lines.map((l) => l.accountId) }, systemKey: { in: GST_ACCOUNT_KEYS } },
      select: { id: true },
    }),
    // Two are enough to know "more than one".
    db.gstRegistration.findMany({ where: { active: true }, select: { id: true }, orderBy: { id: "asc" }, take: 2 }),
  ]);
  if (knownBranches !== branchIds.length) return { ok: false, error: "That branch doesn't exist or is inactive." };
  if (knownRegistrations !== registrationIds.length) {
    return { ok: false, error: "That registration doesn't exist or is inactive." };
  }

  const gstAccountIds = new Set(gstAccounts.map((a) => a.id));
  const onlyRegistration = activeRegistrations.length === 1 ? activeRegistrations[0].id : null;
  if (activeRegistrations.length > 1 && lines.some((l) => gstAccountIds.has(l.accountId) && !l.gstRegistrationId)) {
    return { ok: false, error: "Say which GSTIN this GST line belongs to." };
  }
  const tagged = lines.map((l) =>
    gstAccountIds.has(l.accountId) && !l.gstRegistrationId ? { ...l, gstRegistrationId: onlyRegistration } : l,
  );

  try {
    const entry = await db.$transaction((tx) =>
      writeEntry(tx, {
        date: new Date(input.date),
        narration,
        source: input.source ?? "MANUAL",
        userId: user.id,
        lines: tagged,
      }),
    );
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "JournalEntry",
      entityId: entry.id,
      entityLabel: `${entry.entryNumber} — ${narration}`,
    });
    revalidatePath("/accounting/journal");
    return { ok: true, data: entry };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not write that entry." };
  }
}

export async function listAccounts(opts?: { postableOnly?: boolean }) {
  await requireModuleUser("accounting");
  await ensureChartOfAccounts();
  return toPlain(
    await db.ledgerAccount.findMany({
      where: opts?.postableOnly ? { isGroup: false, active: true } : undefined,
      orderBy: { code: "asc" },
      select: {
        id: true, code: true, name: true, type: true, parentId: true,
        isGroup: true, systemKey: true, active: true, description: true,
      },
    }),
  );
}

export async function saveAccount(input: {
  id?: string;
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
  parentId?: string;
  isGroup?: boolean;
  description?: string;
  active?: boolean;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("accounting");
  if (!(await hasEffectivePermission(user.id, "ledger.manageAccounts"))) {
    return { ok: false, error: "You can't change the chart of accounts." };
  }

  const code = input.code.trim();
  const name = input.name.trim();
  if (!code) return { ok: false, error: "Give the account a code." };
  if (!name) return { ok: false, error: "Give the account a name." };

  const clash = await db.ledgerAccount.findUnique({ where: { code }, select: { id: true } });
  if (clash && clash.id !== input.id) return { ok: false, error: `Code ${code} is already used by another account.` };

  if (input.id) {
    const existing = await db.ledgerAccount.findUnique({
      where: { id: input.id },
      select: { systemKey: true, type: true, _count: { select: { lines: true } } },
    });
    if (!existing) return { ok: false, error: "That account no longer exists." };
    // Changing an account's type after it has been posted to would silently move amounts between
    // the P&L and the balance sheet, including in periods already reported.
    if (existing._count.lines > 0 && existing.type !== input.type) {
      return { ok: false, error: "This account already has entries, so its type can't be changed." };
    }
    if (existing.systemKey && input.active === false) {
      return { ok: false, error: "This account is used by automatic postings and can't be archived." };
    }
  }

  const data = {
    code,
    name,
    type: input.type,
    parentId: input.parentId || null,
    isGroup: input.isGroup ?? false,
    description: input.description?.trim() || null,
    active: input.active ?? true,
  };
  const saved = input.id
    ? await db.ledgerAccount.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.ledgerAccount.create({ data, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "LedgerAccount",
    entityId: saved.id,
    entityLabel: `${code} ${name}`,
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, data: saved };
}

export async function deleteAccount(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("accounting");
  if (!(await hasEffectivePermission(user.id, "ledger.manageAccounts"))) {
    return { ok: false, error: "You can't change the chart of accounts." };
  }

  const account = await db.ledgerAccount.findUnique({
    where: { id },
    select: {
      name: true, code: true, systemKey: true,
      _count: { select: { lines: true, children: true, schedulesExpensed: true, schedulesHeld: true } },
    },
  });
  if (!account) return { ok: false, error: "That account no longer exists." };
  if (account.systemKey) return { ok: false, error: "This account is used by automatic postings and can't be deleted." };
  if (account._count.lines > 0) {
    return { ok: false, error: "This account has entries against it. Archive it instead — deleting would break the books." };
  }
  if (account._count.children > 0) return { ok: false, error: "Move or delete the accounts under it first." };
  // A prepaid or accrual schedule posts to it every month (Revenue & Close) — even one with nothing
  // posted yet holds it, and the database would refuse the delete with a foreign-key error.
  const schedules = account._count.schedulesExpensed + account._count.schedulesHeld;
  if (schedules > 0) {
    return { ok: false, error: `${schedules} prepaid or accrual schedule${schedules === 1 ? " uses" : "s use"} this account. Archive it instead.` };
  }

  await db.ledgerAccount.delete({ where: { id } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LedgerAccount",
    entityId: id,
    entityLabel: `Deleted ${account.code} ${account.name}`,
  });
  revalidatePath("/accounting/accounts");
  return { ok: true, data: null };
}
