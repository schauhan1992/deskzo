"use server";

import { revalidatePath } from "next/cache";
import type { AccountingScheduleKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { lastCompletedMonth, monthKeyOf, monthLabel, parseMonthKey } from "@/lib/close/months";
import {
  createAccountingSchedule,
  editAccountingSchedule,
  getAccountingSchedule,
  listAccountingSchedules,
  runAccountingSchedules,
  stopAccountingSchedule,
  type ScheduleInput,
  type SchedulePatch,
  type ScheduleRunMonth,
} from "@/lib/close/schedules";
import type { ActionResult } from "@/actions/company";

/**
 * Prepaids and accruals (Revenue & Close, spec §4.3) — the screen's actions. The engine is
 * src/lib/close/schedules.ts, which the nightly job also runs as the Automation account.
 *
 * Reading them and running a month is `close.work`; making, changing and stopping one is
 * `close.manage`.
 */

async function access() {
  const user = await requireModuleUser("revenue_close");
  const [work, manage] = await Promise.all([
    hasEffectivePermission(user.id, "close.work"),
    hasEffectivePermission(user.id, "close.manage"),
  ]);
  return { user, work, manage };
}

const NO_MANAGE = "Only somebody who manages the close can set up prepaids and accruals.";

function revalidateSchedules() {
  revalidatePath("/accounting/schedules");
  revalidatePath("/accounting/close");
  revalidatePath("/accounting/journal");
}

export async function listSchedules(filters: { status?: "ACTIVE" | "COMPLETED" | "CANCELLED"; kind?: AccountingScheduleKind } = {}) {
  const { work, manage } = await access();
  if (!work && !manage) return [];
  return toPlain(await listAccountingSchedules(filters));
}

export async function getSchedule(id: string) {
  const { work, manage } = await access();
  if (!work && !manage) return null;
  const row = await getAccountingSchedule(id);
  return row ? toPlain(row) : null;
}

/** What the form picks from: expense accounts, balance-sheet accounts, branches and departments. */
export async function scheduleFormOptions() {
  const { manage } = await access();
  if (!manage) return null;
  const [accounts, branches, departments] = await Promise.all([
    db.ledgerAccount.findMany({
      where: { isGroup: false, active: true, type: { in: ["EXPENSE", "ASSET", "LIABILITY"] } },
      orderBy: { code: "asc" },
      select: { id: true, code: true, name: true, type: true, systemKey: true },
    }),
    db.branch.findMany({ where: { active: true }, orderBy: [{ isHeadOffice: "desc" }, { name: "asc" }], select: { id: true, name: true, code: true } }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return {
    expenseAccounts: accounts.filter((a) => a.type === "EXPENSE"),
    prepaidAccounts: accounts.filter((a) => a.type === "ASSET"),
    accrualAccounts: accounts.filter((a) => a.type === "LIABILITY"),
    branches,
    departments,
  };
}

/** Issued vendor bills a prepaid can be made from, newest first. */
export async function billsForPrepaid(search?: string) {
  const { manage } = await access();
  if (!manage) return [];
  const q = search?.trim();
  const bills = await db.tradeDocument.findMany({
    where: {
      docType: "BILL",
      status: { notIn: ["DRAFT", "CANCELLED"] },
      ...(q
        ? { OR: [{ docNumber: { contains: q, mode: "insensitive" } }, { reference: { contains: q, mode: "insensitive" } }, { company: { name: { contains: q, mode: "insensitive" } } }] }
        : {}),
    },
    orderBy: { issueDate: "desc" },
    take: 25,
    select: {
      id: true, docNumber: true, reference: true, issueDate: true, total: true, currency: true, exchangeRate: true,
      company: { select: { id: true, name: true } },
      _count: { select: { accountingSchedules: true } },
    },
  });
  return toPlain(bills);
}

export async function createSchedule(input: ScheduleInput): Promise<ActionResult<{ id: string; reclassEntryNumber: string | null }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  const result = await createAccountingSchedule(
    { ...input, amount: Number(input.amount), months: Number(input.months) },
    user.id,
  );
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "AccountingSchedule",
    entityId: result.id,
    entityLabel: `${input.kind === "PREPAID" ? "Prepaid" : "Accrual"} ${input.name.trim()} — ₹${Number(input.amount).toLocaleString("en-IN")} over ${input.months} month${Number(input.months) === 1 ? "" : "s"} from ${input.startMonth}${result.reclassEntryNumber ? `, reclass ${result.reclassEntryNumber}` : ""}`,
  });
  revalidateSchedules();
  return { ok: true, data: { id: result.id, reclassEntryNumber: result.reclassEntryNumber } };
}

/** Changes a schedule; only months not yet posted are re-planned. */
export async function editSchedule(id: string, patch: SchedulePatch): Promise<ActionResult<{ adjustmentEntryNumber: string | null }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  const clean: SchedulePatch = {
    ...patch,
    ...(patch.amount !== undefined ? { amount: Number(patch.amount) } : {}),
    ...(patch.months !== undefined ? { months: Number(patch.months) } : {}),
  };
  const result = await editAccountingSchedule(id, clean, user.id);
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AccountingSchedule",
    entityId: id,
    entityLabel: `Changed ${patch.name?.trim() || "a schedule"}${result.adjustmentEntryNumber ? ` — amount adjusted by ${result.adjustmentEntryNumber}` : ""}`,
  });
  revalidateSchedules();
  return { ok: true, data: result };
}

/** Stops a schedule; a prepaid's balance not yet expensed is expensed now. */
export async function stopSchedule(id: string): Promise<ActionResult<{ expensedNow: number; entryNumber: string | null }>> {
  const { user, manage } = await access();
  if (!manage) return { ok: false, error: NO_MANAGE };
  const result = await stopAccountingSchedule(id, user.id);
  if (!result.ok) return result;
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AccountingSchedule",
    entityId: id,
    entityLabel: `Stopped a schedule${result.entryNumber ? ` — ₹${result.expensedNow.toLocaleString("en-IN")} expensed by ${result.entryNumber}` : ""}`,
  });
  revalidateSchedules();
  return { ok: true, data: result };
}

/**
 * "Run schedules through <month>": posts every due month up to a month that has ended — by the person
 * pressing it, where the nightly job posts as the Automation account.
 */
export async function runSchedules(input: { throughMonth: string }): Promise<ActionResult<{ months: ScheduleRunMonth[]; completed: number; skipped: string[] }>> {
  const { user, work } = await access();
  if (!work) return { ok: false, error: "You can't post prepaids and accruals." };
  const now = new Date();
  const through = parseMonthKey(input.throughMonth);
  if (!through) return { ok: false, error: "Choose a month." };
  if (through.getTime() > lastCompletedMonth(now).getTime()) {
    return { ok: false, error: `${monthLabel(through)} hasn't ended yet. Post through ${monthLabel(lastCompletedMonth(now))} at the latest.` };
  }
  const result = await runAccountingSchedules({ throughMonth: through, actorId: user.id, now });
  if (result.months.length) {
    await recordAudit({
      userId: user.id,
      action: "CREATE",
      entityType: "AccountingScheduleRun",
      entityId: monthKeyOf(through),
      entityLabel: `Posted prepaids and accruals through ${monthLabel(through)}: ${result.months.map((m) => m.entryNumber).join(", ")}`,
    });
  }
  revalidateSchedules();
  return { ok: true, data: toPlain(result) };
}
