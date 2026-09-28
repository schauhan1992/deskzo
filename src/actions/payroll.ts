"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { isModuleEnabled } from "@/actions/module";
import { ensureChartOfAccounts, postPayrollPaymentToLedger, postPayrollToLedger } from "@/lib/ledger/journal";
import { payableForPayroll } from "@/actions/incentive";
import { attachToPayslips } from "@/lib/hr/incentive-payout";
import { hasEffectivePermission } from "@/actions/permission";
import { dateOnly, daysInMonth, monthLabel, monthRange } from "@/lib/hr/calendar";
import { lossOfPayDays } from "@/lib/hr/loss-of-pay";
import { annualCtcOf, computePayslip, suggestStructure } from "@/lib/hr/payroll";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { branchIdentity } from "@/lib/branches/identity";
import { payrollRunSchema, payslipAdjustSchema, salaryStructureSchema } from "@/lib/validation/hr";
import type { ActionResult } from "@/actions/company";

/**
 * Salary structures and the monthly payroll run.
 *
 * Everything here is behind a single permission, `payroll.manage`, with one exception: a person may
 * always read their own payslips. Pay is the most sensitive data in the app — not because it is
 * secret from the person it belongs to, but because it is nobody else's business.
 */

// Everything exported from this file must be an async function — a "use server" module publishes
// each export as an endpoint, and Next refuses a synchronous one outright. Pure helpers such as
// annualCtcOf stay in src/lib/hr/payroll.ts, where the client imports them directly.
const n = (value: Prisma.Decimal | Prisma.Decimal.Value | null | undefined) => Number(value ?? 0);
const dec = (value: number) => new Prisma.Decimal(value);

async function requirePayrollAccess() {
  const user = await requireModuleUser("payroll");
  const allowed = await hasEffectivePermission(user.id, "payroll.manage");
  return { user, allowed };
}

// ─── Salary structures ────────────────────────────────────────────────────────

/** What someone is on, newest first. Their own, or anyone's with the permission. */
export async function salaryHistory(userId: string) {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed && user.id !== userId) return [];
  return toPlain(
    await db.salaryStructure.findMany({
      where: { userId },
      orderBy: { effectiveFrom: "desc" },
      include: { createdBy: { select: { name: true } } },
    }),
  );
}

/** The structure in force on a date — the newest one that had already started. */
async function structureOn(userId: string, on: Date) {
  return db.salaryStructure.findFirst({
    where: { userId, effectiveFrom: { lte: on } },
    orderBy: { effectiveFrom: "desc" },
  });
}

export async function saveSalaryStructure(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't set salaries." };

  const parsed = salaryStructureSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const target = await db.user.findUnique({ where: { id: data.userId }, select: { name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  const effectiveFrom = dateOnly(data.effectiveFrom);

  // A second structure starting on the same day is almost certainly a double-submit, and having two
  // would make "which one applied in March" unanswerable.
  const clash = await db.salaryStructure.findFirst({
    where: { userId: data.userId, effectiveFrom },
    select: { id: true },
  });
  if (clash) return { ok: false, error: "There's already a structure starting on that date. Edit it, or pick another date." };

  // Refused rather than silently ignored: changing pay for a month already locked would make the
  // payslip disagree with the structure it claims to come from.
  const locked = await db.payrollRun.findFirst({
    where: {
      status: { in: ["LOCKED", "PAID"] },
      OR: [
        { year: { gt: effectiveFrom.getUTCFullYear() } },
        { year: effectiveFrom.getUTCFullYear(), month: { gte: effectiveFrom.getUTCMonth() + 1 } },
      ],
    },
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { month: true, year: true },
  });
  if (locked) {
    return {
      ok: false,
      error: `Payroll for ${monthLabel(locked.month, locked.year)} is already locked. A structure starting on or before that month would contradict payslips already issued.`,
    };
  }

  const created = await db.salaryStructure.create({
    data: {
      userId: data.userId,
      effectiveFrom,
      basic: dec(data.basic),
      hra: dec(data.hra),
      conveyance: dec(data.conveyance),
      medical: dec(data.medical),
      specialAllowance: dec(data.specialAllowance),
      otherAllowance: dec(data.otherAllowance),
      pfApplicable: data.pfApplicable,
      esiApplicable: data.esiApplicable,
      ptApplicable: data.ptApplicable,
      note: data.note?.trim() || null,
      createdById: user.id,
    },
    select: { id: true },
  });

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "SalaryStructure",
    entityId: created.id,
    entityLabel: `Salary set for ${target.name} from ${data.effectiveFrom}`,
  });
  revalidatePath("/people/payroll");
  revalidatePath(`/people/${data.userId}`);
  return { ok: true, data: created };
}

/** A starting split for a CTC, for the form's "fill from CTC" button. */
export async function suggestFromCtc(annualCtc: number) {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return null;
  return suggestStructure(annualCtc);
}

// ─── The monthly run ──────────────────────────────────────────────────────────

export async function listPayrollRuns() {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return [];
  return toPlain(
    await db.payrollRun.findMany({
      orderBy: [{ year: "desc" }, { month: "desc" }],
      take: 24,
      include: { _count: { select: { payslips: true } } },
    }),
  );
}

/**
 * Builds (or rebuilds) a month's payslips from the structures and attendance in force.
 *
 * Re-runnable while the run is a draft, and deliberately so: attendance gets corrected right up to
 * the day payroll is cut, and the alternative is somebody editing figures by hand. Locking is what
 * makes it final.
 */
export async function runPayroll(input: unknown): Promise<ActionResult<{ id: string; count: number; skipped: string[] }>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't run payroll." };

  const parsed = payrollRunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { month, year } = parsed.data;

  const existing = await db.payrollRun.findUnique({ where: { month_year: { month, year } } });
  if (existing && existing.status !== "DRAFT") {
    return { ok: false, error: `${monthLabel(month, year)} is already ${existing.status.toLowerCase()} and can't be recalculated.` };
  }

  const { to } = monthRange(year, month);
  const monthDays = daysInMonth(year, month);

  // Anyone employed during the month: still active, or exited part-way through it.
  const people = await db.user.findMany({
    where: {
      OR: [
        { active: true },
        { employeeProfile: { exitedOn: { gte: monthRange(year, month).from } } },
      ],
    },
    select: { id: true, name: true, branchId: true, employeeProfile: { select: { state: true, exitedOn: true } } },
    orderBy: { name: "asc" },
  });

  // Professional tax follows the place of work (src/lib/hr/payroll.ts:101-103): the state of the branch
  // someone works at, for people whose branch is set. Nobody else changes — owner decision Q5, pending
  // the CA's C9. Each branch is resolved once, and never inside a transaction.
  const branchIds = [...new Set(people.map((p) => p.branchId).filter((id): id is string => Boolean(id)))];
  const workStates = new Map(
    await Promise.all(
      branchIds.map(async (id) => {
        const identity = await branchIdentity(id);
        return [id, identity.stateCode ? (GST_STATE_CODES[identity.stateCode] ?? null) : identity.state] as const;
      }),
    ),
  );

  const run =
    existing ??
    (await db.payrollRun.create({ data: { month, year, createdById: user.id } }));

  const skipped: string[] = [];
  const slips: Prisma.PayslipCreateManyInput[] = [];

  // Read before anything is replaced. Income tax and any manual deduction are typed in by whoever
  // runs payroll, not computed, so a recalculation must carry them across or it would silently
  // wipe them — see the note at the top of src/lib/hr/payroll.ts on why tax is not derived here.
  const carried = new Map(
    (
      await db.payslip.findMany({
        where: { runId: run.id },
        select: { userId: true, incomeTax: true, otherDeduction: true, otherDeductionNote: true },
      })
    ).map((slip) => [slip.userId, slip]),
  );

  // Approved incentives waiting to go out with this month's salary. Paid through payroll rather
  // than separately, because performance pay is taxable salary and belongs on the payslip — paying
  // it outside would leave it off Form 16 and out of the PT and ESI computation.
  const incentives = await payableForPayroll(month, year);
  const incentiveByUser = new Map<string, { total: number; ids: string[]; labels: string[] }>();
  for (const row of incentives) {
    const bucket = incentiveByUser.get(row.userId) ?? { total: 0, ids: [], labels: [] };
    bucket.total = Math.round((bucket.total + row.amount) * 100) / 100;
    bucket.ids.push(row.id);
    bucket.labels.push(row.label);
    incentiveByUser.set(row.userId, bucket);
  }

  for (const person of people) {
    const structure = await structureOn(person.id, to);
    if (!structure) {
      skipped.push(`${person.name} — no salary structure`);
      continue;
    }

    const lop = await lossOfPayDays(person.id, year, month);
    const result = computePayslip({
      components: {
        basic: n(structure.basic),
        hra: n(structure.hra),
        conveyance: n(structure.conveyance),
        medical: n(structure.medical),
        specialAllowance: n(structure.specialAllowance),
        otherAllowance: n(structure.otherAllowance),
      },
      flags: {
        pfApplicable: structure.pfApplicable,
        esiApplicable: structure.esiApplicable,
        ptApplicable: structure.ptApplicable,
      },
      monthDays,
      lopDays: lop,
      state: (person.branchId ? workStates.get(person.branchId) : null) ?? person.employeeProfile?.state ?? null,
      month,
      incentive: incentiveByUser.get(person.id)?.total ?? 0,
    });

    const prior = carried.get(person.id);
    const incomeTax = n(prior?.incomeTax);
    const otherDeduction = n(prior?.otherDeduction);
    const totalDeductions =
      result.pfEmployee + result.esiEmployee + result.professionalTax + incomeTax + otherDeduction;

    slips.push({
      runId: run.id,
      userId: person.id,
      monthDays: dec(result.monthDays),
      paidDays: dec(result.paidDays),
      lopDays: dec(result.lopDays),
      basic: dec(result.components.basic),
      hra: dec(result.components.hra),
      conveyance: dec(result.components.conveyance),
      medical: dec(result.components.medical),
      specialAllowance: dec(result.components.specialAllowance),
      otherAllowance: dec(result.components.otherAllowance),
      incentive: dec(result.incentive),
      grossEarnings: dec(result.grossEarnings),
      pfEmployee: dec(result.pfEmployee),
      pfEmployer: dec(result.pfEmployer),
      esiEmployee: dec(result.esiEmployee),
      esiEmployer: dec(result.esiEmployer),
      professionalTax: dec(result.professionalTax),
      incomeTax: dec(incomeTax),
      otherDeduction: dec(otherDeduction),
      otherDeductionNote: prior?.otherDeductionNote ?? null,
      totalDeductions: dec(totalDeductions),
      netPay: dec(result.grossEarnings - totalDeductions),
      employerCost: dec(result.employerCost),
      note: result.warnings.length > 0 ? result.warnings.join(" ") : null,
    });
  }

  // Replaced wholesale rather than reconciled row by row: a recalculation is a fresh answer to the
  // same question, and matching old rows to new ones would only create ways for the two to diverge.
  await db.$transaction(async (tx) => {
    await tx.payslip.deleteMany({ where: { runId: run.id } });
    await tx.payslip.createMany({ data: slips });
  });

  // Marked paid only after the payslips are written, and only for people who actually got one —
  // an earning tied to a payslip that failed to write would be an incentive nobody can pay again.
  if (incentiveByUser.size > 0) {
    const written = await db.payslip.findMany({
      where: { runId: run.id, userId: { in: [...incentiveByUser.keys()] } },
      select: { id: true, userId: true },
    });
    const pairs = written.flatMap((slip) =>
      (incentiveByUser.get(slip.userId)?.ids ?? []).map((earningId) => ({ earningId, payslipId: slip.id })),
    );
    if (pairs.length > 0) await attachToPayslips(pairs);
  }

  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "PayrollRun",
    entityId: run.id,
    entityLabel: `Payroll for ${monthLabel(month, year)} — ${slips.length} payslip(s)`,
  });
  revalidatePath("/people/payroll");
  return { ok: true, data: { id: run.id, count: slips.length, skipped } };
}

export async function getPayrollRun(
  id: string,
  filters?: { search?: string; departmentId?: string; sort?: string; flag?: string },
) {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return null;

  // Sorting by net or by loss of pay is what a register is read for — "who is being paid least this
  // month and why" is one question, and scanning 200 alphabetical rows is not an answer to it.
  const orderBy =
    filters?.sort === "net"
      ? { netPay: "desc" as const }
      : filters?.sort === "lop"
        ? { lopDays: "desc" as const }
        : { user: { name: "asc" as const } };

  const run = await db.payrollRun.findUnique({
    where: { id },
    include: {
      lockedBy: { select: { name: true } },
      payslips: {
        where: {
          ...(filters?.flag === "lop" ? { lopDays: { gt: 0 } } : {}),
          ...(filters?.flag === "flagged" ? { note: { not: null } } : {}),
          ...(filters?.departmentId ? { user: { departmentId: filters.departmentId } } : {}),
          ...(filters?.search
            ? {
                user: {
                  OR: [
                    { name: { contains: filters.search, mode: "insensitive" as const } },
                    { employeeProfile: { employeeCode: { contains: filters.search, mode: "insensitive" as const } } },
                  ],
                },
              }
            : {}),
        },
        orderBy,
        include: { user: { select: { id: true, name: true, employeeProfile: { select: { employeeCode: true, designation: true } } } } },
      },
    },
  });
  return run ? toPlain(run) : null;
}

/** The whole month regardless of filters, so the header totals describe the run and not the view. */
export async function payrollRunTotals(id: string) {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return null;
  const agg = await db.payslip.aggregate({
    where: { runId: id },
    _sum: { grossEarnings: true, totalDeductions: true, netPay: true, employerCost: true },
    _count: { _all: true },
  });
  return {
    count: agg._count._all,
    gross: n(agg._sum.grossEarnings),
    deductions: n(agg._sum.totalDeductions),
    net: n(agg._sum.netPay),
    cost: n(agg._sum.employerCost),
  };
}

/** Hand-entered figures the engine deliberately does not compute. */
export async function adjustPayslip(input: unknown): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't edit payslips." };

  const parsed = payslipAdjustSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const slip = await db.payslip.findUnique({
    where: { id: data.id },
    include: { run: { select: { status: true, month: true, year: true } }, user: { select: { name: true } } },
  });
  if (!slip) return { ok: false, error: "That payslip no longer exists." };
  if (slip.run.status !== "DRAFT") {
    return { ok: false, error: "That month is locked. A locked payslip is a record, not a draft." };
  }

  const statutory = n(slip.pfEmployee) + n(slip.esiEmployee) + n(slip.professionalTax);
  const totalDeductions = statutory + data.incomeTax + data.otherDeduction;

  await db.payslip.update({
    where: { id: data.id },
    data: {
      incomeTax: dec(data.incomeTax),
      otherDeduction: dec(data.otherDeduction),
      otherDeductionNote: data.otherDeductionNote?.trim() || null,
      totalDeductions: dec(totalDeductions),
      netPay: dec(n(slip.grossEarnings) - totalDeductions),
      note: data.note?.trim() || slip.note,
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Payslip",
    entityId: data.id,
    entityLabel: `Adjusted ${slip.user.name}'s payslip for ${monthLabel(slip.run.month, slip.run.year)}`,
  });
  revalidatePath("/people/payroll");
  return { ok: true, data: null };
}

/**
 * Locking, then marking paid.
 *
 * Locking is the point of no return, so it is its own deliberate step rather than a side effect of
 * anything else. After it, the payslips are a statement that has been made.
 */
export async function setPayrollStatus(id: string, status: "LOCKED" | "PAID" | "DRAFT"): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't change a payroll run." };

  const run = await db.payrollRun.findUnique({ where: { id }, select: { status: true, month: true, year: true, _count: { select: { payslips: true } } } });
  if (!run) return { ok: false, error: "That run no longer exists." };

  if (status === "LOCKED" && run._count.payslips === 0) {
    return { ok: false, error: "There's nothing to lock — run the payroll first." };
  }
  if (status === "DRAFT" && run.status === "PAID") {
    return { ok: false, error: "A run that has been paid can't go back to draft." };
  }
  if (status === "PAID" && run.status === "DRAFT") {
    return { ok: false, error: "Lock the run before marking it paid." };
  }

  await db.payrollRun.update({
    where: { id },
    data: {
      status,
      ...(status === "LOCKED" ? { lockedAt: new Date(), lockedById: user.id } : {}),
      ...(status === "PAID" ? { paidAt: new Date() } : {}),
      ...(status === "DRAFT" ? { lockedAt: null, lockedById: null } : {}),
    },
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "PayrollRun",
    entityId: id,
    entityLabel: `${monthLabel(run.month, run.year)} payroll marked ${status.toLowerCase()}`,
  });

  // Locking is when a run stops being a calculation and becomes a statement, so that is when it
  // reaches the books. A draft run is still being corrected, and a wage bill that moves after it has
  // been posted is how a P&L ends up disagreeing with the payslips behind it.
  let postingWarning: string | null = null;
  if (status === "LOCKED") postingWarning = await postPayrollRunToBooks(id, user.id);
  // And marking it paid is the net actually leaving the bank — a separate event on a separate day,
  // which is the whole reason salaries payable exists between the two.
  if (status === "PAID") postingWarning = await postPayrollPaymentToBooks(id, user.id);

  revalidatePath("/people/payroll");
  revalidatePath("/accounting/journal");
  if (postingWarning) {
    return { ok: false, error: `Marked ${status.toLowerCase()}, but it didn't reach the ledger: ${postingWarning}` };
  }
  return { ok: true, data: null };
}

/**
 * Books a locked run.
 *
 * Returns the problem rather than throwing it, for the same reason the expense posting does: a run
 * that did not post shows up on the unposted list and can be posted again, whereas a lock rolled
 * back because the chart was mid-edit leaves payslips nobody can issue.
 */
async function postPayrollRunToBooks(runId: string, userId: string): Promise<string | null> {
  if (!(await isModuleEnabled("accounting"))) return null;
  try {
    await ensureChartOfAccounts();
    await db.$transaction((tx) => postPayrollToLedger(tx, runId, userId));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not post this run to the ledger.";
  }
}

async function postPayrollPaymentToBooks(runId: string, userId: string): Promise<string | null> {
  if (!(await isModuleEnabled("accounting"))) return null;
  try {
    await ensureChartOfAccounts();
    await db.$transaction(async (tx) => {
      // A run that was locked while accounting was switched off has no wage entry yet; without this
      // the payment would settle a liability that was never raised.
      await postPayrollToLedger(tx, runId, userId);
      await postPayrollPaymentToLedger(tx, runId, userId, new Date());
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "Could not post the salary payment to the ledger.";
  }
}

/** Runs the ledger never received — the list that makes the quiet failures above defensible. */
export async function unpostedPayrollRuns() {
  const { allowed } = await requirePayrollAccess();
  if (!allowed) return [];
  return toPlain(
    await db.payrollRun.findMany({
      where: {
        status: { in: ["LOCKED", "PAID"] },
        journalEntries: { none: { source: "PAYROLL" } },
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
      select: { id: true, month: true, year: true, status: true, _count: { select: { payslips: true } } },
    }),
  );
}

/** Posts a run the ledger missed. */
export async function postPayrollRunToLedger(runId: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't post a payroll run." };
  const problem = await postPayrollRunToBooks(runId, user.id);
  revalidatePath("/people/payroll");
  revalidatePath("/accounting/journal");
  return problem ? { ok: false, error: problem } : { ok: true, data: null };
}

/** Somebody's own payslips — the one payroll read that needs no permission. */
export async function myPayslips() {
  const user = await requireModuleUser("payroll");
  return toPlain(
    await db.payslip.findMany({
      where: { userId: user.id, run: { status: { in: ["LOCKED", "PAID"] } } },
      orderBy: [{ run: { year: "desc" } }, { run: { month: "desc" } }],
      include: { run: { select: { month: true, year: true, status: true, paidAt: true } } },
    }),
  );
}

/** One payslip, for the person it belongs to or for payroll. */
export async function getPayslip(id: string) {
  const user = await requireModuleUser("payroll");
  const slip = await db.payslip.findUnique({
    where: { id },
    include: {
      run: { select: { month: true, year: true, status: true, paidAt: true } },
      user: {
        select: {
          id: true, name: true, email: true,
          employeeProfile: {
            select: { employeeCode: true, designation: true, panNumber: true, uanNumber: true, bankAccountNumber: true, joinedOn: true },
          },
        },
      },
    },
  });
  if (!slip) return null;
  if (slip.userId !== user.id && !(await hasEffectivePermission(user.id, "payroll.manage"))) return null;
  // Drafts are working figures — nobody but payroll should see one and think it is their pay.
  if (slip.run.status === "DRAFT" && slip.userId === user.id) return null;
  return toPlain(slip);
}
