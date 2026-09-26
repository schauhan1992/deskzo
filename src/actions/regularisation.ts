"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { attendanceStatusValues } from "@/lib/validation/hr";
import type { ActionResult } from "@/actions/company";

/**
 * Asking for a day of your own attendance to be corrected.
 *
 * The whole point is that raising one changes nothing. Attendance drives loss of pay, so an
 * employee editing their own would be an employee editing their own salary — the request is the
 * self-service part, and the decision stays with a manager or HR exactly as it did before.
 */

const regularisationSchema = z
  .object({
    date: z.string().min(1, "Pick the day."),
    requestedStatus: z.enum(attendanceStatusValues),
    checkIn: z.string().trim().optional().or(z.literal("")),
    checkOut: z.string().trim().optional().or(z.literal("")),
    reason: z.string().trim().min(3, "Say what happened — the approver has to decide on something."),
  })
  .superRefine((val, ctx) => {
    if (val.checkIn && val.checkOut && val.checkOut <= val.checkIn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Check-out is before check-in.", path: ["checkOut"] });
    }
  });

const decisionSchema = z.object({
  id: z.string().min(1),
  approve: z.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

async function canDecide(deciderId: string, requesterId: string) {
  // Never your own, whatever else is true — the same rule leave uses.
  if (deciderId === requesterId) return false;
  if (await hasEffectivePermission(deciderId, "hr.manage")) return true;
  if (await hasEffectivePermission(deciderId, "hr.approveLeave")) return true;
  return (await getDownlineUserIds(deciderId)).includes(requesterId);
}

const selectShape = {
  id: true,
  date: true,
  requestedStatus: true,
  requestedCheckIn: true,
  requestedCheckOut: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  user: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceRegularisationSelect;

export async function requestRegularisation(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("hr");
  const parsed = regularisationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  const date = dateOnly(data.date);
  if (date > dateOnly(new Date())) {
    return { ok: false, error: "That day hasn't happened yet." };
  }

  // One open request per day. A second would give two approvers the same decision to make, and the
  // loser's answer would silently vanish.
  const open = await db.attendanceRegularisation.findFirst({
    where: { userId: user.id, date, status: "PENDING" },
    select: { id: true },
  });
  if (open) return { ok: false, error: "You already have a request awaiting a decision for that day." };

  const existing = await db.attendanceDay.findUnique({
    where: { userId_date: { userId: user.id, date } },
    select: { leaveRequestId: true },
  });
  if (existing?.leaveRequestId) {
    return { ok: false, error: "That day is approved leave. Withdraw the leave instead, or ask HR to correct it." };
  }

  const me = await db.user.findUnique({ where: { id: user.id }, select: { managerId: true, name: true } });

  const created = await db.attendanceRegularisation.create({
    data: {
      userId: user.id,
      date,
      requestedStatus: data.requestedStatus,
      requestedCheckIn: data.checkIn ? new Date(`${data.date}T${data.checkIn}:00Z`) : null,
      requestedCheckOut: data.checkOut ? new Date(`${data.date}T${data.checkOut}:00Z`) : null,
      reason: data.reason,
      approverId: me?.managerId ?? null,
    },
    select: { id: true },
  });

  if (me?.managerId) {
    await notifyUser({
      userId: me.managerId,
      type: "REGULARISATION_REQUESTED",
      title: "Attendance correction requested",
      message: `${me.name} has asked for ${toKey(date)} to be marked ${data.requestedStatus.toLowerCase().replaceAll("_", " ")}.`,
      link: "/people/me",
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "AttendanceRegularisation",
    entityId: created.id,
    entityLabel: `Asked for ${toKey(date)} to be marked ${data.requestedStatus.toLowerCase().replaceAll("_", " ")}`,
  });
  revalidatePath("/people/attendance");
  revalidatePath("/people/me");
  return { ok: true, data: created };
}

export async function decideRegularisation(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, approve, note } = parsed.data;

  const request = await db.attendanceRegularisation.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.status !== "PENDING") return { ok: false, error: `It was already ${request.status.toLowerCase()}.` };
  if (!(await canDecide(user.id, request.userId))) return { ok: false, error: "You can't decide this request." };

  const workedMinutes =
    request.requestedCheckIn && request.requestedCheckOut
      ? Math.max(
          0,
          Math.round((request.requestedCheckOut.getTime() - request.requestedCheckIn.getTime()) / 60000),
        )
      : null;

  await db.$transaction(async (tx) => {
    await tx.attendanceRegularisation.update({
      where: { id },
      data: { status: approve ? "APPROVED" : "REJECTED", approverId: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    for (const op of (approve
      ? [
          tx.attendanceDay.upsert({
            where: { userId_date: { userId: request.userId, date: request.date } },
            create: {
              userId: request.userId,
              date: request.date,
              status: request.requestedStatus,
              checkInAt: request.requestedCheckIn,
              checkOutAt: request.requestedCheckOut,
              workedMinutes,
              note: `Corrected: ${request.reason}`,
              regularisedById: user.id,
              regularisedAt: new Date(),
            },
            update: {
              status: request.requestedStatus,
              checkInAt: request.requestedCheckIn,
              checkOutAt: request.requestedCheckOut,
              workedMinutes,
              note: `Corrected: ${request.reason}`,
              regularisedById: user.id,
              regularisedAt: new Date(),
            },
          }),
        ]
      : [])) await op;
  });

  await notifyUser({
    userId: request.userId,
    type: "REGULARISATION_DECIDED",
    title: `Attendance correction ${approve ? "approved" : "rejected"}`,
    message: `${user.name} ${approve ? "approved" : "rejected"} your correction for ${toKey(request.date)}${note ? `: ${note}` : "."}`,
    link: "/people/me",
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceRegularisation",
    entityId: id,
    entityLabel: `${approve ? "Approved" : "Rejected"} ${request.user.name}'s correction for ${toKey(request.date)}`,
  });
  revalidatePath("/people/attendance");
  revalidatePath("/people/me");
  return { ok: true, data: null };
}

export async function cancelRegularisation(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const request = await db.attendanceRegularisation.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.userId !== user.id) return { ok: false, error: "That isn't your request." };
  if (request.status !== "PENDING") return { ok: false, error: "Only a request still awaiting a decision can be withdrawn." };

  await db.attendanceRegularisation.update({ where: { id }, data: { status: "CANCELLED" } });
  revalidatePath("/people/me");
  return { ok: true, data: null };
}

export async function myRegularisations() {
  const user = await requireModuleUser("hr");
  return toPlain(
    await db.attendanceRegularisation.findMany({
      where: { userId: user.id },
      orderBy: { date: "desc" },
      take: 30,
      select: selectShape,
    }),
  );
}

/** Corrections waiting on this user to decide. */
export async function regularisationQueue() {
  const user = await requireModuleUser("hr");
  const wide =
    (await hasEffectivePermission(user.id, "hr.manage")) || (await hasEffectivePermission(user.id, "hr.approveLeave"));
  const downline = await getDownlineUserIds(user.id);
  const scope = wide ? { userId: { not: user.id } } : { userId: { in: downline } };

  return toPlain(
    await db.attendanceRegularisation.findMany({
      where: { ...scope, status: "PENDING" },
      orderBy: { date: "asc" },
      select: selectShape,
    }),
  );
}
