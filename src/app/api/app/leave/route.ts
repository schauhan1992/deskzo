import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { iso } from "@/lib/api/refs";
import { listLeaveTypes } from "@/actions/hr";
import { applyForLeave, leaveBalances, myLeaveRequests } from "@/actions/leave";

/**
 * Leave from the Deskzo app (owner, 18 Oct 2026). GET: the leave types, the person's balances and their requests.
 * POST: `{ type_id, from, to, from_half_day?, to_half_day?, reason }` — the web's own applyForLeave, its rules.
 */

export const dynamic = "force-dynamic";

const day = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export const GET = appRoute({}, async ({ actor }) => {
  await needAppModule("hr", actor.userId);
  const [types, balances, requests] = await Promise.all([listLeaveTypes(), leaveBalances(actor.userId), myLeaveRequests()]);
  return {
    data: {
      types: types.map((t) => ({ id: t.id, code: t.code, name: t.name, paid: t.paid })),
      balances: balances.map((b) => ({ type_id: b.typeId, name: b.name, paid: b.paid, available: b.available, pending: b.pending, used: b.used })),
      requests: requests.slice(0, 50).map((r) => ({
        id: r.id,
        type: r.type.name,
        from: day(r.fromDate),
        to: day(r.toDate),
        from_half_day: r.fromHalfDay,
        to_half_day: r.toHalfDay,
        days: Number(r.days),
        reason: r.reason,
        status: r.status,
        note: r.decisionNote,
        decided_by: r.approver?.name ?? null,
        asked_at: iso(r.createdAt),
      })),
    },
  };
});

export const POST = appRoute({}, async ({ actor, body }) => {
  await needAppModule("hr", actor.userId);
  const input = await body();
  const result = await applyForLeave({
    typeId: input.type_id,
    fromDate: input.from,
    toDate: input.to,
    fromHalfDay: input.from_half_day === true,
    toHalfDay: input.to_half_day === true,
    reason: input.reason,
  });
  if (!result.ok) refused(result);
  return { status: 201, data: { id: result.data.id, days: result.data.days } };
});
