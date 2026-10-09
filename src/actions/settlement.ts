"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { dateOnly, daysInMonth, financialYearOf, monthLabel } from "@/lib/hr/calendar";
import { employmentInMonth, monthlyGross } from "@/lib/hr/payroll";
import { computeSettlement, finalMonthDays, type EncashableBalance } from "@/lib/hr/settlement";
import { lossOfPayDays } from "@/lib/hr/loss-of-pay";
import { ensureBalance } from "@/lib/hr/leave-balance";
import type { ActionResult } from "@/actions/company";

/**
 * Full and final settlement.
 *
 * Behind `payroll.manage` rather than `hr.manage`, with one exception: the person it belongs to may
 * read their own once it has been approved. A settlement is a payment, and who may see and decide
 * one is the same question as who may see and decide a payslip.
 *
 * Like payroll, this is re-runnable while it is a draft and frozen afterwards. Attendance and leave
 * balances move right up to the last day, and the alternative to recalculating is somebody editing
 * figures by hand.
 */

const dec = (v: number) => new Prisma.Decimal(v);
const n = (v: Prisma.Decimal | Prisma.Decimal.Value | null | undefined) => Number(v ?? 0);

async function payrollAccess() {
  const user = await requireModuleUser("payroll");
  return { user, allowed: await hasEffectivePermission(user.id, "payroll.manage") };
}

export type SettlementOverrides = {
  resignedOn?: string;
  bonusAmount?: number;
  otherEarnings?: number;
  otherEarningsNote?: string;
  advanceRecovery?: number;
  assetRecovery?: number;
  otherDeduction?: number;
  otherDeductionNote?: string;
  incomeTax?: number;
  professionalTax?: number;
  pfDeduction?: number;
  note?: string;
};

/**
 * Builds the settlement from the record as it stands.
 *
 * Everything statutory is computed — gratuity, encashment, notice recovery — and everything
 * discretionary is passed in. That split is the point: an advance being recovered is a decision
 * somebody makes, and gratuity is not.
 */
export async function buildSettlement(
  userId: string,
  overrides?: SettlementOverrides,
): Promise<ActionResult<{ id: string; netPayable: number; warnings: string[] }>> {
  const { user, allowed } = await payrollAccess();
  if (!allowed) return { ok: false, error: "You can't prepare a settlement." };

  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      employeeProfile: true,
      salaryStructures: { orderBy: { effectiveFrom: "desc" }, take: 1 },
    },
  });
  if (!person) return { ok: false, error: "That user no longer exists." };

  const profile = person.employeeProfile;
  if (!profile?.exitedOn) {
    return { ok: false, error: "Record their exit first — a settlement needs a last working day." };
  }
  if (!profile.joinedOn) {
    return { ok: false, error: "No joining date on the record, so service and gratuity can't be worked out." };
  }
  const structure = person.salaryStructures[0];
  if (!structure) return { ok: false, error: "No salary structure on file, so there is nothing to settle." };

  const existing = await db.finalSettlement.findUnique({ where: { userId }, select: { id: true, status: true } });
  if (existing && existing.status !== "DRAFT") {
    return { ok: false, error: `That settlement is already ${existing.status.toLowerCase()} and can't be recalculated.` };
  }

  const lastWorkingDay = profile.exitedOn;
  const basic = n(structure.basic);
  const gross = monthlyGross({
    basic,
    hra: n(structure.hra),
    conveyance: n(structure.conveyance),
    medical: n(structure.medical),
    specialAllowance: n(structure.specialAllowance),
    otherAllowance: n(structure.otherAllowance),
  });

  // Days of the final month still owed: the days employed in it up to the last working day, less
  // whatever attendance says was unpaid, less whatever that month's locked payslip already paid. The
  // month is paid once — by a locked payroll run if it got there first, otherwise here, and then the
  // run leaves them out (src/lib/hr/payroll-month.ts) and refuses to lock while it still pays them
  // (setPayrollStatus). A draft payslip is not counted: it is a calculation that will be redone.
  const month = lastWorkingDay.getUTCMonth() + 1;
  const year = lastWorkingDay.getUTCFullYear();
  const monthDays = daysInMonth(year, month);
  const employed = employmentInMonth(year, month, profile.joinedOn, lastWorkingDay);
  const lop = employed ? await lossOfPayDays(userId, year, month, employed) : 0;
  const payslip = await db.payslip.findFirst({
    where: { userId, run: { month, year, status: { in: ["LOCKED", "PAID"] } } },
    select: { paidDays: true },
  });
  const finalMonth = finalMonthDays({
    employedDays: employed?.days ?? 0,
    lopDays: lop,
    paidOnPayslip: payslip ? n(payslip.paidDays) : null,
  });
  const salaryDays = finalMonth.salaryDays;
  const notes: string[] = [];
  if (finalMonth.onPayslip > 0) {
    notes.push(
      `${monthLabel(month, year)}'s locked payslip already pays ${finalMonth.onPayslip} day(s), so ${finalMonth.salaryDays > 0 ? `only the other ${finalMonth.salaryDays} are` : "none of that month is"} paid here.`,
    );
  }
  if (finalMonth.overpaidDays > 0) {
    const overpaid = Math.round((gross / monthDays) * finalMonth.overpaidDays);
    notes.push(
      `${monthLabel(month, year)}'s payslip paid ${finalMonth.overpaidDays} day(s) past what they were owed (about ₹${overpaid.toLocaleString("en-IN")} gross) — that month was locked before the exit was recorded. Add it under other deductions to recover it.`,
    );
  }

  // Only balances on a type marked encashable are paid out; the rest are reported and dropped. Read
  // for the year they left in, brought up to date first — accrued to the last working day, and opened
  // with what the year before carried forward. An encashable type is counted even if nobody ever
  // opened their balance of it; any other type only where a balance exists, as before.
  const leaveYear = financialYearOf(lastWorkingDay);
  const leaveTypes = await db.leaveType.findMany({
    where: {
      paid: true,
      OR: [{ active: true, encashable: true }, { balances: { some: { userId, year: leaveYear } } }],
    },
    orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
  });
  const encashable: EncashableBalance[] = [];
  for (const type of leaveTypes) {
    const b = await ensureBalance(userId, type.id, leaveYear, lastWorkingDay);
    if (!b) continue;
    encashable.push({
      code: type.code,
      name: type.name,
      days: Math.max(0, n(b.opening) + n(b.credited) + n(b.adjustment) - n(b.used)),
      encashable: type.encashable,
    });
  }

  const resignedOn = overrides?.resignedOn
    ? dateOnly(overrides.resignedOn)
    : new Date(lastWorkingDay.getTime() - (profile.noticePeriodDays ?? 30) * 86400000);

  const result = computeSettlement({
    monthlyBasic: basic,
    monthlyGross: gross,
    joinedOn: profile.joinedOn,
    resignedOn,
    lastWorkingDay,
    noticePeriodDays: profile.noticePeriodDays ?? 30,
    salaryDays,
    daysInFinalMonth: monthDays,
    balances: encashable,
    bonusAmount: overrides?.bonusAmount,
    otherEarnings: overrides?.otherEarnings,
    advanceRecovery: overrides?.advanceRecovery,
    assetRecovery: overrides?.assetRecovery,
    otherDeduction: overrides?.otherDeduction,
    incomeTax: overrides?.incomeTax,
    professionalTax: overrides?.professionalTax,
    pfDeduction: overrides?.pfDeduction,
  });
  const warnings = [...notes, ...result.warnings];

  const data = {
    userId,
    lastWorkingDay,
    serviceYears: dec(result.serviceYears),
    salaryDays: dec(salaryDays),
    salaryAmount: dec(result.salaryAmount),
    leaveEncashDays: dec(result.encashment.days),
    leaveEncashAmount: dec(result.encashment.amount),
    gratuityAmount: dec(result.gratuity.amount),
    gratuityNote: result.gratuity.note,
    bonusAmount: dec(result.bonusAmount),
    otherEarnings: dec(result.otherEarnings),
    otherEarningsNote: overrides?.otherEarningsNote?.trim() || null,
    grossPayable: dec(result.grossPayable),
    noticeShortfallDays: dec(result.notice.shortfallDays),
    noticeRecovery: dec(result.notice.recovery),
    pfDeduction: dec(overrides?.pfDeduction ?? 0),
    professionalTax: dec(overrides?.professionalTax ?? 0),
    incomeTax: dec(overrides?.incomeTax ?? 0),
    advanceRecovery: dec(overrides?.advanceRecovery ?? 0),
    assetRecovery: dec(overrides?.assetRecovery ?? 0),
    otherDeduction: dec(overrides?.otherDeduction ?? 0),
    otherDeductionNote: overrides?.otherDeductionNote?.trim() || null,
    totalDeductions: dec(result.totalDeductions),
    netPayable: dec(result.netPayable),
    note: overrides?.note?.trim() || (warnings.length ? warnings.join(" ") : null),
    createdById: user.id,
  };

  const row = await db.finalSettlement.upsert({
    where: { userId },
    create: data,
    update: data,
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "FinalSettlement",
    entityId: row.id,
    entityLabel: `Settlement for ${person.name} — net ${result.netPayable < 0 ? "recoverable" : "payable"} ₹${Math.abs(result.netPayable).toLocaleString("en-IN")}`,
  });
  revalidatePath(`/people/${userId}`);
  revalidatePath(`/people/${userId}/settlement`);
  return { ok: true, data: { id: row.id, netPayable: result.netPayable, warnings } };
}

export async function getSettlement(userId: string) {
  const user = await requireModuleUser("payroll");
  const isSelf = user.id === userId;
  const allowed = await hasEffectivePermission(user.id, "payroll.manage");
  if (!allowed && !isSelf) return null;

  const row = await db.finalSettlement.findUnique({
    where: { userId },
    include: {
      user: { select: { id: true, name: true, employeeProfile: { select: { employeeCode: true, designation: true, joinedOn: true } } } },
      approvedBy: { select: { name: true } },
      createdBy: { select: { name: true } },
    },
  });
  if (!row) return null;
  // A draft is payroll's working copy — the employee sees it once it has been approved.
  if (row.status === "DRAFT" && !allowed) return null;
  return toPlain(row);
}

export async function setSettlementStatus(
  userId: string,
  status: "APPROVED" | "PAID" | "DRAFT",
): Promise<ActionResult<null>> {
  const { user, allowed } = await payrollAccess();
  if (!allowed) return { ok: false, error: "You can't change a settlement." };

  const row = await db.finalSettlement.findUnique({ where: { userId }, select: { status: true, user: { select: { name: true } } } });
  if (!row) return { ok: false, error: "There's no settlement to change." };
  if (status === "PAID" && row.status === "DRAFT") {
    return { ok: false, error: "Approve it before marking it paid." };
  }
  if (status === "DRAFT" && row.status === "PAID") {
    return { ok: false, error: "A settlement that has been paid can't go back to draft." };
  }

  await db.finalSettlement.update({
    where: { userId },
    data: {
      status,
      ...(status === "APPROVED" ? { approvedAt: new Date(), approvedById: user.id } : {}),
      ...(status === "PAID" ? { paidAt: new Date() } : {}),
      ...(status === "DRAFT" ? { approvedAt: null, approvedById: null } : {}),
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "FinalSettlement",
    entityId: userId,
    entityLabel: `${row.user.name}'s settlement marked ${status.toLowerCase()}`,
  });
  revalidatePath(`/people/${userId}/settlement`);
  return { ok: true, data: null };
}

/** Everybody who has left and still has no settled account. */
export async function pendingSettlements() {
  const { allowed } = await payrollAccess();
  if (!allowed) return [];
  return toPlain(
    await db.user.findMany({
      where: { employeeProfile: { exitedOn: { not: null } }, settlement: { is: null } },
      select: {
        id: true,
        name: true,
        employeeProfile: { select: { employeeCode: true, designation: true, exitedOn: true, joinedOn: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
}
