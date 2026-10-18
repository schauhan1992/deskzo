import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/handler";
import { iso } from "@/lib/api/refs";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { clockIn, clockOut, myToday } from "@/actions/attendance";
import { decideLeave, leaveApprovalQueue, leaveBalances, myLeaveRequests } from "@/actions/leave";
import { decideRegularisation, regularisationQueue } from "@/actions/regularisation";
import { decideExpense, listExpensesPaged } from "@/actions/expense";
import { decideApproval as decideWorkflowApproval, getApprovalsInbox } from "@/actions/automate";
import { approveOrder, listOrdersPaged } from "@/actions/order";
import { decideDevice, listDevices } from "@/actions/access-control";
import { countTasks, listTasks } from "@/actions/task";

/**
 * The Deskzo app's everyday screens (owner, 18 Oct 2026) — Today, Tasks, Approvals, Leave and clocking in —
 * over the app's own actions, as the phone's person (src/lib/app/handler.ts). Each asks its module of them
 * first, as its pages do; within it, the actions' own rules decide.
 */

const MODULE_NAMES: Record<string, string> = { hr: "Attendance and leave", tasks: "Tasks", expenses: "Expenses", orders: "Orders", notifications: "Approvals" };

/** A module the person may open now — or a 403 that says why. */
export async function needAppModule(key: string, userId: string): Promise<void> {
  const access = await moduleAccessFor(userId, key);
  if (access === "available") return;
  const name = MODULE_NAMES[key] ?? key;
  throw new ApiError(403, "module_unavailable", access === "not-entitled" ? `${name} isn't in your workspace's plan.` : access === "switched-off" ? `${name} is switched off in your workspace.` : `You can't use ${name} in Deskzo.`);
}

/** Whether the person may open a module now — the module first, as check:module-guards reads it. */
const appModuleOpen = async (key: string, userId: string): Promise<boolean> => (await moduleAccessFor(userId, key)) === "available";

/** An action's refusal, in its own words. */
export function refused(result: { ok: boolean; error?: string }): never {
  throw new ApiError(422, "refused", result.error ?? "Deskzo said no.");
}

const shiftDay = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ─── Attendance ───────────────────────────────────────────────────────────────

export function attendanceOut(row: Awaited<ReturnType<typeof myToday>>) {
  return row
    ? { status: row.status, check_in_at: iso(row.checkInAt), check_out_at: iso(row.checkOutAt), worked_minutes: row.workedMinutes ?? null }
    : { status: null, check_in_at: null, check_out_at: null, worked_minutes: null };
}

export type PhoneLocation = { latitude: number; longitude: number; accuracy: number | null };

/** A location the phone sent, or null for none or one that can't be a place. */
export function readLocation(body: Record<string, unknown>): PhoneLocation | null {
  const lat = Number(body.latitude);
  const lng = Number(body.longitude);
  if (body.latitude === undefined || body.latitude === null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  const accuracy = Number(body.accuracy);
  return { latitude: lat, longitude: lng, accuracy: Number.isFinite(accuracy) && accuracy >= 0 ? Math.min(100_000, Math.round(accuracy)) : null };
}

/** Clocking in or out from the phone: the web's own action, with where the phone was when it shares that. */
export async function clockFromPhone(userId: string, appDeviceId: string, action: "in" | "out", location: PhoneLocation | null) {
  await needAppModule("hr", userId);
  const result = action === "in" ? await clockIn() : await clockOut();
  if (!result.ok) refused(result);
  if (location) {
    const clock = await workspaceClock();
    await db.attendanceLocation.create({
      data: { userId, date: clock.calendarDate(new Date()), kind: action === "in" ? "IN" : "OUT", latitude: location.latitude, longitude: location.longitude, accuracyM: location.accuracy, appDeviceId },
    });
  }
  return attendanceOut(await myToday());
}

// ─── Today ────────────────────────────────────────────────────────────────────

const taskOut = (t: { id: string; title: string; dueDate: Date | string | null; status: string; priority: string | null; company?: { name: string } | null; canWork?: boolean }) => ({
  id: t.id,
  title: t.title,
  due: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : null,
  status: t.status,
  priority: t.priority,
  company: t.company?.name ?? null,
  can_work: t.canWork !== false,
});

/** The Today screen: clocked in or not, tasks due today and overdue, what waits for a decision, leave left. */
export async function todayFor(userId: string) {
  const clock = await workspaceClock();
  const today = clock.today();
  const [hr, tasks] = await Promise.all([appModuleOpen("hr", userId), appModuleOpen("tasks", userId)]);
  const [attendance, dueToday, counts, approvals, balances, leave] = await Promise.all([
    hr ? myToday().then(attendanceOut) : null,
    tasks ? listTasks({ assignedToUserId: userId, status: "open", dueFrom: today, dueTo: today }) : null,
    tasks ? countTasks({ assignedToUserId: userId, status: "open" }) : null,
    approvalsFor(userId).then((a) => a.length),
    hr ? leaveBalances(userId) : null,
    hr ? myLeaveRequests() : null,
  ]);
  return {
    date: today,
    attendance,
    tasks: tasks ? { due_today: (dueToday ?? []).slice(0, 20).map(taskOut), open: counts?.open ?? 0, overdue: counts?.overdue ?? 0 } : null,
    approvals_waiting: approvals,
    leave: hr
      ? {
          balances: (balances ?? []).filter((b) => b.paid || b.available > 0).map((b) => ({ type_id: b.typeId, code: b.code, name: b.name, available: b.available, pending: b.pending })),
          upcoming: (leave ?? [])
            .filter((l) => (l.status === "APPROVED" || l.status === "PENDING") && new Date(l.toDate).toISOString().slice(0, 10) >= today)
            .slice(0, 5)
            .map((l) => ({ id: l.id, type: l.type.name, from: new Date(l.fromDate).toISOString().slice(0, 10), to: new Date(l.toDate).toISOString().slice(0, 10), days: Number(l.days), status: l.status })),
        }
      : null,
  };
}

export async function tasksFor(userId: string, view: string) {
  await needAppModule("tasks", userId);
  const today = (await workspaceClock()).today();
  const params =
    view === "today"
      ? { status: "open" as const, dueFrom: today, dueTo: today }
      : view === "overdue"
        ? { status: "open" as const, dueTo: shiftDay(today, -1) }
        : view === "done"
          ? { status: "done" as const }
          : { status: "open" as const };
  const rows = await listTasks({ assignedToUserId: userId, ...params, sort: "due", dir: "asc" });
  return rows.slice(0, 100).map(taskOut);
}

// ─── Approvals ────────────────────────────────────────────────────────────────

export const APPROVAL_KINDS = ["leave", "correction", "expense", "workflow", "order", "device"] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalItem = {
  kind: ApprovalKind;
  id: string;
  title: string;
  detail: string | null;
  from: string | null;
  asked_at: string | null;
  /** A refusal needs a reason. */
  reason_to_reject: boolean;
};

const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * Everything waiting for this person's decision that the phone can decide: leave, attendance corrections,
 * expense claims, Deskzo Automate approval steps, orders and devices — each from its own queue, so each
 * keeps its own rule about who decides.
 */
export async function approvalsFor(userId: string): Promise<ApprovalItem[]> {
  const [hr, expenses, workflows, orders, ordersApprove, devices] = await Promise.all([
    appModuleOpen("hr", userId),
    appModuleOpen("expenses", userId),
    appModuleOpen("notifications", userId),
    appModuleOpen("orders", userId),
    can(userId, "orders.approve"),
    can(userId, "access.approveDevices"),
  ]);
  const items: ApprovalItem[] = [];
  const lists = await Promise.all([
    hr ? leaveApprovalQueue().then((q) => q.pending) : [],
    hr ? regularisationQueue() : [],
    expenses ? listExpensesPaged({ awaitingMyDecision: true, page: 1, pageSize: 50 }).then((r) => r.rows) : [],
    workflows ? getApprovalsInbox().then((i) => i.waiting.filter((w) => w.source === "workflow")) : [],
    orders && ordersApprove ? listOrdersPaged({ status: "PENDING_APPROVAL", page: 1, pageSize: 50 } as never).then((r) => r.rows) : [],
    devices ? listDevices({ status: "PENDING", pageSize: 50 }).then((r) => r?.rows ?? []) : [],
  ]);
  const [leave, corrections, claims, steps, pendingOrders, pendingDevices] = lists as [
    Awaited<ReturnType<typeof leaveApprovalQueue>>["pending"],
    Awaited<ReturnType<typeof regularisationQueue>>,
    Awaited<ReturnType<typeof listExpensesPaged>>["rows"],
    Awaited<ReturnType<typeof getApprovalsInbox>>["waiting"],
    Awaited<ReturnType<typeof listOrdersPaged>>["rows"],
    NonNullable<Awaited<ReturnType<typeof listDevices>>>["rows"],
  ];
  for (const l of leave) {
    items.push({ kind: "leave", id: l.id, title: `${l.user.name}: ${l.type.name}, ${l.days} day${Number(l.days) === 1 ? "" : "s"}`, detail: `${day(l.fromDate)}${day(l.toDate) !== day(l.fromDate) ? ` to ${day(l.toDate)}` : ""} · ${l.reason}`, from: l.user.name, asked_at: iso(l.createdAt), reason_to_reject: false });
  }
  for (const r of corrections) {
    const times = [r.requestedCheckIn ? `in ${r.requestedCheckIn}` : null, r.requestedCheckOut ? `out ${r.requestedCheckOut}` : null].filter(Boolean).join(", ");
    items.push({ kind: "correction", id: r.id, title: `${r.user.name}: attendance on ${day(r.date)}`, detail: `${String(r.requestedStatus).toLowerCase().replaceAll("_", " ")}${times ? ` (${times})` : ""} · ${r.reason}`, from: r.user.name, asked_at: iso(r.createdAt), reason_to_reject: false });
  }
  for (const e of claims as unknown as { id: string; amount: number | string; description: string; category: string; spentOn: string; createdAt: string; user: { id: string; name: string } }[]) {
    if (e.user.id === userId) continue;
    items.push({ kind: "expense", id: e.id, title: `${e.user.name}: ₹${Number(e.amount).toLocaleString("en-IN")} ${String(e.category).toLowerCase().replaceAll("_", " ")}`, detail: `${day(e.spentOn)} · ${e.description}`, from: e.user.name, asked_at: iso(e.createdAt), reason_to_reject: true });
  }
  for (const s of steps) {
    items.push({ kind: "workflow", id: s.id, title: s.title, detail: s.summary, from: s.from, asked_at: iso(s.askedAt), reason_to_reject: false });
  }
  for (const o of pendingOrders as unknown as { id: string; orderSeq: number; quantity: number; createdAt: string; company: { name: string }; item: { name: string } | null; addedBy: { id: string; name: string } | null }[]) {
    if (o.addedBy?.id === userId) continue;
    items.push({ kind: "order", id: o.id, title: `Order ORD-${o.orderSeq}: ${o.company.name}`, detail: `${o.quantity} × ${o.item?.name ?? "item"}`, from: o.addedBy?.name ?? null, asked_at: iso(o.createdAt), reason_to_reject: false });
  }
  for (const d of pendingDevices as unknown as { id: string; label: string; firstSeenAt: string; lastPlace: string | null; user: { id: string; name: string } }[]) {
    if (d.user.id === userId) continue;
    items.push({ kind: "device", id: d.id, title: `${d.user.name}: a new device`, detail: `${d.label}${d.lastPlace ? ` · ${d.lastPlace}` : ""}`, from: d.user.name, asked_at: iso(d.firstSeenAt), reason_to_reject: false });
  }
  return items.sort((a, b) => (a.asked_at ?? "").localeCompare(b.asked_at ?? ""));
}

/** One decision, by the action that owns that kind — its rules, its refusals. */
export async function decideFromPhone(kind: ApprovalKind, id: string, approve: boolean, note: string | null) {
  const n = note?.trim() || undefined;
  const result =
    kind === "leave"
      ? await decideLeave({ id, approve, note: n })
      : kind === "correction"
        ? await decideRegularisation({ id, approve, note: n })
        : kind === "expense"
          ? await decideExpense({ id, approved: approve, note: n })
          : kind === "workflow"
            ? await decideWorkflowApproval(id, approve ? "approved" : "rejected", n ?? null)
            : kind === "order"
              ? await approveOrder({ orderId: id, approved: approve, notes: n })
              : await decideDevice(id, approve ? "APPROVE" : "REJECT", n);
  if (!result.ok) refused(result);
}
