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
import { annualCtcOf, computePayslip, salaryPartsInMonth, suggestStructure } from "@/lib/hr/payroll";
import { formatCalendarDay } from "@/lib/time/zone";
import { workOutTds } from "@/lib/hr/tds";
import { computeProfessionalTax, normaliseState, ptRuleFor, seniorCitizenIn } from "@/lib/hr/professional-tax";
import { alsoPaidBySettlement, payrollMonth, ptHistoryFor, settlementsRelyingOn, workStateOf } from "@/lib/hr/payroll-month";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { branchIdentity } from "@/lib/branches/identity";
import { payrollRunSchema, payslipAdjustSchema, salaryStructureSchema, taxDeclarationSchema } from "@/lib/validation/hr";
import { TAX_YEARS, taxYearOf } from "@/lib/hr/income-tax";
import { workspaceClock } from "@/lib/time/workspace";
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

/** Every structure that has taken effect by `on` — split into the month's parts by `salaryPartsInMonth`. */
async function structuresBy(userId: string, on: Date) {
  return db.salaryStructure.findMany({ where: { userId, effectiveFrom: { lte: on } }, orderBy: { effectiveFrom: "asc" } });
}

type Money = Parameters<typeof n>[0];
const componentsOf = (s: { basic: Money; hra: Money; conveyance: Money; medical: Money; specialAllowance: Money; otherAllowance: Money }) => ({
  basic: n(s.basic),
  hra: n(s.hra),
  conveyance: n(s.conveyance),
  medical: n(s.medical),
  specialAllowance: n(s.specialAllowance),
  otherAllowance: n(s.otherAllowance),
});

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

  // Anyone employed for part of the month at least, and for which days (src/lib/hr/payroll-month.ts).
  const { people, skipped } = await payrollMonth(year, month);

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

  const slips: Prisma.PayslipCreateManyInput[] = [];

  // Read before anything is replaced. A manual deduction, and income tax wherever somebody typed it
  // over Deskzo's figure, were typed by whoever runs payroll, so a recalculation carries them across
  // rather than silently wipe them. Worked-out TDS is worked out again.
  const carried = new Map(
    (
      await db.payslip.findMany({
        where: { runId: run.id },
        select: { userId: true, incomeTax: true, incomeTaxBasis: true, otherDeduction: true, otherDeductionNote: true },
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

  // Professional tax looks back at this financial year's earlier payslips: Tamil Nadu charges on the
  // half-year's income, and nobody pays more than ₹2,500 a year (src/lib/hr/professional-tax.ts).
  const ptHistory = await ptHistoryFor(people.map((p) => p.id), year, month);

  for (const person of people) {
    const incentive = incentiveByUser.get(person.id)?.total ?? 0;
    // Their settlement pays this month's days. Nothing else to pay means no payslip; an approved
    // incentive still goes out here, on a payslip of no days, so it is taxed and marked paid like
    // anyone else's — a settlement has no line that would do either.
    if (person.salaryInSettlement && incentive <= 0) {
      skipped.push(`${person.name} — this month's salary is in their full and final settlement`);
      continue;
    }
    // The month by salary structure: a revision inside it pays each part at its own rate.
    const salaryParts = salaryPartsInMonth(await structuresBy(person.id, to), year, month);
    const structure = salaryParts[salaryParts.length - 1]?.structure;
    if (!structure) {
      skipped.push(`${person.name} — no salary structure`);
      continue;
    }

    const lop = person.salaryInSettlement ? 0 : await lossOfPayDays(person.id, year, month, person.employment);
    // With a revision, the loss of pay is counted in each part's own days, so a day off is docked at
    // the rate it would have been paid at.
    const employed = person.employment;
    const parts =
      salaryParts.length > 1 && !person.salaryInSettlement
        ? await Promise.all(
            salaryParts.map(async (p) => {
              const firstDay = Math.max(p.firstDay, employed.firstDay);
              const lastDay = Math.min(p.lastDay, employed.lastDay);
              const lopDays = lastDay >= firstDay ? await lossOfPayDays(person.id, year, month, { firstDay, lastDay }) : 0;
              return { components: componentsOf(p.structure), firstDay: p.firstDay, lastDay: p.lastDay, lopDays };
            }),
          )
        : undefined;
    const backdated = salaryParts[0]?.backdated && employed.firstDay < salaryParts[0].structure.effectiveFrom.getUTCDate();
    const prior = carried.get(person.id);
    const flags = { pfApplicable: structure.pfApplicable, esiApplicable: structure.esiApplicable, ptApplicable: structure.ptApplicable };
    const workState = (person.branchId ? workStates.get(person.branchId) : null) ?? person.state ?? null;
    const slipInput = {
      components: componentsOf(structure),
      parts,
      flags,
      monthDays,
      lopDays: lop,
      employment: person.employment,
      salaryInSettlement: person.salaryInSettlement,
      state: workState,
      gender: person.gender,
      ptHistory: ptHistory.get(person.id),
      seniorCitizen: seniorCitizenIn(person.dateOfBirth, month >= 4 ? year : year - 1),
      leavingThisMonth: person.leaving,
      month,
      year,
      incentive,
    };

    // TDS: a figure typed on this month's draft is kept — and so is one on a payslip from before Deskzo
    // worked it out (no basis), where every figure was typed. Otherwise it's worked out from the tax
    // year so far (src/lib/hr/tds.ts), on the payslip as computed without it; then the payslip is
    // computed again with it, since Punjab's development tax follows income tax.
    const typed = !!prior && (prior.incomeTaxBasis === "TYPED" || (prior.incomeTaxBasis === null && n(prior.incomeTax) > 0));
    let incomeTax = typed ? n(prior.incomeTax) : 0;
    let tds: Awaited<ReturnType<typeof workOutTds>> = null;
    if (!typed) {
      const first = computePayslip({ ...slipInput, incomeTax: 0, incomeTaxWorkedOut: true });
      tds = await workOutTds({
        userId: person.id,
        year,
        month,
        thisMonth: { gross: first.grossEarnings, pf: first.pfEmployee, pt: first.professionalTax },
        rate: { components: componentsOf(structure), flags, state: workState, gender: person.gender },
        joinedOn: person.joinedOn,
        exitedOn: person.exitedOn,
        dateOfBirth: person.dateOfBirth,
      });
      incomeTax = tds?.amount ?? 0;
    }
    const result = computePayslip({ ...slipInput, incomeTax, incomeTaxWorkedOut: !!tds });
    const basis = typed ? ("TYPED" as const) : tds ? ("WORKED_OUT" as const) : null;
    if (!typed && !tds && result.grossEarnings > 0) {
      result.warnings = [...result.warnings.filter((w) => !w.startsWith("No income tax entered")), "Deskzo doesn't work out TDS for this tax year — type it on the payslip."];
    }
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
      incomeTaxBasis: basis,
      taxWorking: tds ? (tds as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      otherDeduction: dec(otherDeduction),
      otherDeductionNote: prior?.otherDeductionNote ?? null,
      totalDeductions: dec(totalDeductions),
      netPay: dec(result.grossEarnings - totalDeductions),
      employerCost: dec(result.employerCost),
      note:
        [
          ...result.warnings,
          ...(tds?.warnings ?? []),
          ...(backdated ? [`No salary structure before ${formatCalendarDay(salaryParts[0]!.structure.effectiveFrom)} — the days before it were paid at the one from that day.`] : []),
        ].join(" ") || null,
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
        omit: { incomeTaxBasis: false, taxWorking: false },
        include: { user: { select: { id: true, userSeq: true, name: true, employeeProfile: { select: { employeeCode: true, designation: true } } } } },
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
    omit: { incomeTaxBasis: false, taxWorking: false },
    include: { run: { select: { status: true, month: true, year: true } }, user: { select: { name: true } } },
  });
  if (!slip) return { ok: false, error: "That payslip no longer exists." };
  if (slip.run.status !== "DRAFT") {
    return { ok: false, error: "That month is locked. A locked payslip is a record, not a draft." };
  }
  const state = await workStateOf(slip.userId);
  const { year, month } = slip.run;
  const monthEnd = monthRange(year, month).to;

  // TDS: worked out again on request; a figure changed from the one on the payslip is typed, and a
  // recalculation keeps it; the same figure saved again keeps whatever it was.
  let incomeTax = data.incomeTax;
  let incomeTaxBasis = slip.incomeTaxBasis;
  let taxWorking: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
  if (data.workOutTax) {
    const structure = await structureOn(slip.userId, monthEnd);
    const profile = await db.employeeProfile.findUnique({ where: { userId: slip.userId }, select: { joinedOn: true, exitedOn: true, dateOfBirth: true, gender: true } });
    if (!structure) return { ok: false, error: "No salary structure on file, so there's no rate to work the year out on." };
    const tds = await workOutTds({
      userId: slip.userId,
      year,
      month,
      thisMonth: { gross: n(slip.grossEarnings), pf: n(slip.pfEmployee), pt: n(slip.professionalTax) },
      rate: {
        components: componentsOf(structure),
        flags: { pfApplicable: structure.pfApplicable, esiApplicable: structure.esiApplicable, ptApplicable: structure.ptApplicable },
        state,
        gender: profile?.gender ?? null,
      },
      joinedOn: profile?.joinedOn ?? null,
      exitedOn: profile?.exitedOn ?? null,
      dateOfBirth: profile?.dateOfBirth ?? null,
    });
    if (!tds) return { ok: false, error: "Deskzo doesn't work out TDS for this tax year — type it." };
    incomeTax = tds.amount;
    incomeTaxBasis = "WORKED_OUT";
    taxWorking = tds as unknown as Prisma.InputJsonValue;
  } else if (Math.abs(data.incomeTax - n(slip.incomeTax)) >= 0.005) {
    incomeTaxBasis = "TYPED";
    taxWorking = Prisma.DbNull;
  }

  // Punjab's development tax follows income tax (src/lib/hr/professional-tax.ts): typing income tax in,
  // or taking it out, decides whether this payslip owes it. Every other state's stands as the run set it.
  let professionalTax = n(slip.professionalTax);
  const rule = state ? ptRuleFor(normaliseState(state), year, month) : null;
  if (rule?.rule.kind === "INCOME_TAX_PAYERS") {
    const structure = await structureOn(slip.userId, monthEnd);
    const history = (await ptHistoryFor([slip.userId], slip.run.year, slip.run.month)).get(slip.userId);
    const profile = await db.employeeProfile.findUnique({ where: { userId: slip.userId }, select: { dateOfBirth: true } });
    professionalTax = computeProfessionalTax({
      monthGross: n(slip.grossEarnings),
      state,
      month: slip.run.month,
      year: slip.run.year,
      applicable: structure?.ptApplicable ?? false,
      paidThisYear: history?.paidThisYear,
      deductsIncomeTax: incomeTax > 0,
      seniorCitizen: seniorCitizenIn(profile?.dateOfBirth, slip.run.month >= 4 ? slip.run.year : slip.run.year - 1),
    }).amount;
  }

  const statutory = n(slip.pfEmployee) + n(slip.esiEmployee) + professionalTax;
  const totalDeductions = statutory + incomeTax + data.otherDeduction;

  await db.payslip.update({
    where: { id: data.id },
    data: {
      professionalTax: dec(professionalTax),
      incomeTax: dec(incomeTax),
      incomeTaxBasis,
      ...(taxWorking !== undefined ? { taxWorking } : {}),
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
  // A run calculated before somebody's full and final settlement was made still pays them the month
  // the settlement pays too. Recalculating leaves them out (src/lib/hr/payroll-month.ts); locking
  // first would make the double payment a statement.
  if (status === "LOCKED" && run.status === "DRAFT") {
    const paidTwice = await alsoPaidBySettlement(id, run.year, run.month);
    if (paidTwice.length > 0) {
      return {
        ok: false,
        error: `${paidTwice.join(", ")} ${paidTwice.length === 1 ? "is" : "are"} also paid for ${monthLabel(run.month, run.year)} in a full and final settlement. Recalculate the run so it leaves them out, then lock it.`,
      };
    }
  }
  if (status === "DRAFT" && run.status === "PAID") {
    return { ok: false, error: "A run that has been paid can't go back to draft." };
  }
  if (status === "DRAFT" && run.status === "LOCKED") {
    const relying = await settlementsRelyingOn(id, run.year, run.month);
    if (relying.length > 0) {
      return {
        ok: false,
        error: `${relying.join(", ")}'s full and final settlement is approved and leaves part of ${monthLabel(run.month, run.year)} to this run's payslip. Recalculating would pay those days to nobody — put the settlement back to draft first, and recalculate it once this run is locked again.`,
      };
    }
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
// ─── Income tax declarations ──────────────────────────────────────────────────

const DECLARED = ["hraExemption", "section80C", "section80CCD1B", "section80D", "homeLoanInterest", "otherDeductions", "previousGross", "previousTds", "previousPt", "previousPf", "otherIncome", "otherTds"] as const;
export type TaxDeclarationView = { taxYear: number; regime: "NEW" | "OLD"; note: string | null; updatedAt: string | null } & Record<(typeof DECLARED)[number], number>;

/**
 * Somebody's income tax declarations — this tax year's and last year's, whichever Deskzo works TDS out
 * for — what TDS is worked out from (src/lib/hr/tds.ts). Payroll's to see and set; a person sees their
 * own.
 */
export async function taxDeclarations(userId: string): Promise<{ years: number[]; current: number; declarations: TaxDeclarationView[] } | null> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed && user.id !== userId) return null;
  const today = (await workspaceClock()).calendarDate(new Date());
  const current = taxYearOf(today.getUTCFullYear(), today.getUTCMonth() + 1);
  const years = [current, current - 1].filter((y) => TAX_YEARS[y]);
  const rows = await db.taxDeclaration.findMany({ where: { userId, taxYear: { in: years } } });
  const declarations = years.map((taxYear) => {
    const row = rows.find((r) => r.taxYear === taxYear);
    return {
      taxYear,
      regime: row?.regime ?? ("NEW" as const),
      note: row?.note ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      ...(Object.fromEntries(DECLARED.map((k) => [k, n(row?.[k])])) as Record<(typeof DECLARED)[number], number>),
    };
  });
  return { years, current, declarations };
}

export async function saveTaxDeclaration(input: unknown): Promise<ActionResult<null>> {
  const { user, allowed } = await requirePayrollAccess();
  if (!allowed) return { ok: false, error: "You can't set income tax declarations." };
  const parsed = taxDeclarationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { userId, taxYear, regime, note, ...amounts } = parsed.data;
  if (!TAX_YEARS[taxYear]) return { ok: false, error: "Deskzo doesn't work out TDS for that tax year." };
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!person) return { ok: false, error: "That person no longer exists." };

  const data = { regime, note: note || null, updatedById: user.id, ...Object.fromEntries(DECLARED.map((k) => [k, dec(amounts[k])])) };
  await db.taxDeclaration.upsert({ where: { userId_taxYear: { userId, taxYear } }, create: { userId, taxYear, ...data }, update: data });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "TaxDeclaration",
    entityId: `${userId}:${taxYear}`,
    entityLabel: `Income tax declaration for ${person.name}, tax year ${taxYear}-${String((taxYear + 1) % 100).padStart(2, "0")} (${regime === "NEW" ? "new" : "old"} regime)`,
  });
  revalidatePath("/people");
  return { ok: true, data: null };
}

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
    omit: { incomeTaxBasis: false, taxWorking: false },
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
