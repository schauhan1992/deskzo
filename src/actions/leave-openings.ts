"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { financialYearLabel, financialYearOf } from "@/lib/hr/calendar";
import { ensureBalance, TYPED_OPENING } from "@/lib/hr/leave-balance";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Opening leave balances (owner, 17 Oct 2026), for a company that moves to Deskzo partway through a
 * year: for each person and paid leave type, what they carried into the year from the old system, and
 * what they had already taken this year before Deskzo. The year's own grant is still worked out here,
 * from its first day, so the two together give the balance the old system had.
 *
 * Typed, the carried figure takes the place of the carry Deskzo would work out from last year — a
 * year it never saw. The taken figure is counted into `used`, so every balance, request and
 * settlement sees it. Next year carries from this one as usual. HR only (`hr.manage`).
 */

const n = (value: Prisma.Decimal | number | null | undefined) => Number(value ?? 0);
const days = z.coerce.number().min(0, "Days can't be negative.").max(366, "That's more than a year of leave.").multipleOf(0.5, "Use whole or half days.");

const saveSchema = z.object({
  year: z.coerce.number().int(),
  rows: z
    .array(
      z.object({
        userId: z.string().min(1),
        typeId: z.string().min(1),
        /** Null: leave the carry to be worked out from last year. */
        opening: days.nullable(),
        usedBefore: days,
      }),
    )
    .max(5000),
  note: z.string().trim().max(500).optional(),
});

export type LeaveOpeningCell = { typed: number | null; usedBefore: number; opening: number | null };
export type LeaveOpeningSheet = {
  year: number;
  label: string;
  years: { year: number; label: string }[];
  types: { id: string; code: string; name: string; carryForward: boolean }[];
  people: { id: string; name: string; email: string; department: string | null; cells: Record<string, LeaveOpeningCell> }[];
};

async function hrManager() {
  const user = await requireModuleUser("hr");
  return (await hasEffectivePermission(user.id, "hr.manage")) ? user : null;
}

/** This year, or the one before — for a company that moves across on 1 April with last year's closing. */
async function openYears() {
  const today = (await workspaceClock()).calendarDate(new Date());
  const current = financialYearOf(today);
  return { today, current, allowed: [current, current - 1] };
}

/** Everybody employed at some point in the year, with what has been typed for them so far. */
export async function leaveOpeningSheet(year?: number): Promise<LeaveOpeningSheet | null> {
  if (!(await hrManager())) return null;
  const { current, allowed } = await openYears();
  const fy = year && allowed.includes(year) ? year : current;
  const yearStart = new Date(Date.UTC(fy, 3, 1));

  const [types, people] = await Promise.all([
    db.leaveType.findMany({
      where: { active: true, paid: true },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: { id: true, code: true, name: true, carryForward: true },
    }),
    db.user.findMany({
      where: {
        ...PEOPLE_ONLY,
        OR: [
          { active: true, employeeProfile: { is: null } },
          { active: true, employeeProfile: { exitedOn: null } },
          { employeeProfile: { exitedOn: { gte: yearStart } } },
        ],
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, department: { select: { name: true } } },
    }),
  ]);
  const balances = await db.leaveBalance.findMany({
    where: { year: fy, userId: { in: people.map((p) => p.id) }, typeId: { in: types.map((t) => t.id) } },
    select: { userId: true, typeId: true, opening: true, openingTyped: true, usedBefore: true },
  });
  const byKey = new Map(balances.map((b) => [`${b.userId}:${b.typeId}`, b]));

  return {
    year: fy,
    label: financialYearLabel(fy),
    years: allowed.map((y) => ({ year: y, label: financialYearLabel(y) })),
    types,
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      department: p.department?.name ?? null,
      cells: Object.fromEntries(
        types.map((t) => {
          const b = byKey.get(`${p.id}:${t.id}`);
          return [t.id, { typed: b?.openingTyped == null ? null : n(b.openingTyped), usedBefore: n(b?.usedBefore), opening: b ? n(b.opening) : null }];
        }),
      ),
    })),
  };
}

/**
 * Saves what was typed. Only cells that changed need sending; a cell sent with no carried figure goes
 * back to the carry worked out from last year. Taking the taken-before figure back out of `used` is
 * refused when requests since have used those days.
 */
export async function saveLeaveOpenings(input: unknown): Promise<ActionResult<{ saved: number }>> {
  const user = await hrManager();
  if (!user) return { ok: false, error: "You can't set leave balances." };
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { year, rows, note } = parsed.data;
  const { today, allowed } = await openYears();
  if (!allowed.includes(year)) return { ok: false, error: `Opening balances can be typed for ${allowed.map(financialYearLabel).join(" or ")} only.` };
  if (rows.length === 0) return { ok: true, data: { saved: 0 } };

  const [types, people] = await Promise.all([
    db.leaveType.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.typeId))] } }, select: { id: true, paid: true, name: true } }),
    db.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] }, ...PEOPLE_ONLY }, select: { id: true, name: true } }),
  ]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  const personById = new Map(people.map((p) => [p.id, p]));
  for (const row of rows) {
    const type = typeById.get(row.typeId);
    if (!type) return { ok: false, error: "One of those leave types no longer exists." };
    if (!type.paid) return { ok: false, error: `${type.name} is unpaid — it has no balance to bring across.` };
    if (!personById.has(row.userId)) return { ok: false, error: "One of those people no longer exists." };
  }

  let saved = 0;
  for (const row of rows) {
    // Made and brought up to date first, so the row exists and its own figures are current.
    await ensureBalance(row.userId, row.typeId, year, today);
    const balance = await db.leaveBalance.findUniqueOrThrow({
      where: { userId_typeId_year: { userId: row.userId, typeId: row.typeId, year } },
      omit: TYPED_OPENING,
    });
    const used = n(balance.used) - n(balance.usedBefore) + row.usedBefore;
    if (used < 0) {
      const who = personById.get(row.userId)!.name;
      return { ok: false, error: `${who}'s ${typeById.get(row.typeId)!.name} would go below nothing taken — saved ${saved} before it.` };
    }
    await db.leaveBalance.update({
      where: { id: balance.id },
      data: {
        openingTyped: row.opening === null ? null : new Prisma.Decimal(row.opening),
        // The typed figure is the opening straight away; one taken back out starts from nothing and is
        // worked out again below (a type that doesn't carry stays at nothing).
        opening: new Prisma.Decimal(row.opening ?? 0),
        usedBefore: new Prisma.Decimal(row.usedBefore),
        used: new Prisma.Decimal(used),
        openingNote: note || null,
      },
    });
    if (row.opening === null) await ensureBalance(row.userId, row.typeId, year, today);
    saved += 1;
  }

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "LeaveBalance",
    entityId: `opening-${year}`,
    entityLabel: `Opening leave balances for ${financialYearLabel(year)}: ${saved} ${saved === 1 ? "balance" : "balances"}${note ? ` — ${note}` : ""}`,
  });
  revalidatePath("/people/leave");
  return { ok: true, data: { saved } };
}
