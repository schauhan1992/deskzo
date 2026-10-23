import type { ApprovalStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { resolveValue, type RunContext } from "@/lib/automate/references";
import { requestWakeHere } from "@/lib/automate/wake";

/**
 * The approvals inbox (Deskzo Automate, Phase 6): what waits for somebody to approve or reject.
 *
 *   · An approval step names people — by id, "owner" (the workflow's), or a reference to a person —
 *     and may name a role besides. Only they may decide: a person named, or anybody holding the role
 *     when they decide. Both must be active users.
 *   · The first decision counts; a second, or one after the time ran out, is refused. Deciding wakes
 *     the run, which takes the approved or rejected steps.
 *   · The engine creates a request when a run reaches the step, and settles one nobody decided in
 *     time (src/lib/automate/engine.ts).
 *
 * The AI copilot's own proposals stay in copilot_proposals and are shown in the same inbox, decided
 * through the copilot's own confirm and cancel; requests of kind AGENT_PROPOSAL are for the agents to come.
 */

/** The active people an approval names, by id — and the role, kept as it is. */
export async function resolveApprovers(approvers: string[], context: RunContext, ownerId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const raw of approvers) {
    const value = raw === "owner" ? ownerId : resolveValue(raw, context);
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  }
  if (!ids.size) return [];
  const active = await db.user.findMany({ where: { id: { in: [...ids] }, active: true }, select: { id: true } });
  return active.map((u) => u.id);
}

/** Everybody to tell: the people named, and the active holders of the role. */
export async function approversToTell(approverIds: string[], role: string | null): Promise<string[]> {
  const holders = role ? await db.user.findMany({ where: { role, active: true }, select: { id: true }, take: 50 }) : [];
  return [...new Set([...approverIds, ...holders.map((h) => h.id)])];
}

export async function tellApprovers(userIds: string[], title: string, workflowName: string): Promise<void> {
  for (const userId of userIds) {
    // On their iPhone too: a workflow's approval is on the Deskzo app's Approvals screen, unlike its other messages.
    await notifyUser({ userId, type: "WORKFLOW_MESSAGE", title: `Approval needed: ${title}`.slice(0, 200), message: `The workflow "${workflowName}" is waiting for you to approve or reject.`, link: "/approvals", awaitsDecision: true }).catch(() => undefined);
  }
}

/** Whether this person may decide this request now. */
export async function mayDecide(request: { approverIds: string[]; approverRole: string | null }, userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { active: true, role: true } });
  if (!user?.active) return false;
  return request.approverIds.includes(userId) || (!!request.approverRole && user.role === request.approverRole);
}

export type Decision = "approved" | "rejected";

/**
 * Records a decision and wakes the run waiting on it — or says why it can't: not theirs to make,
 * already made, or too late.
 */
export async function decide(requestId: string, userId: string, decision: Decision, comment: string | null, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const request = await db.approvalRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, approverIds: true, approverRole: true, expiresAt: true, runId: true } });
  if (!request) return { ok: false, error: "That approval isn't there any more." };
  if (!(await mayDecide(request, userId))) return { ok: false, error: "You aren't one of the people asked to decide this." };
  if (request.status !== "PENDING") return { ok: false, error: request.status === "CANCELLED" ? "That run was stopped, so there's nothing to decide." : "Somebody has already decided this." };
  if (request.expiresAt <= now) return { ok: false, error: "The time to decide has run out; the workflow went the way it was set to go." };
  const status: ApprovalStatus = decision === "approved" ? "APPROVED" : "REJECTED";
  const done = await db.approvalRequest.updateMany({ where: { id: request.id, status: "PENDING" }, data: { status, decidedById: userId, decidedAt: now, comment: comment?.trim().slice(0, 1000) || null } });
  if (!done.count) return { ok: false, error: "Somebody has already decided this." };
  if (request.runId) {
    const woken = await db.automationRun.updateMany({ where: { id: request.runId, status: "WAITING" }, data: { runAfter: now } });
    if (woken.count) await requestWakeHere(now);
  }
  return { ok: true };
}

/** The requests waiting on this person — named, or by their role — and the ones they decided lately. */
export async function inboxFor(userId: string, take = 50) {
  const me = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  const mine = { OR: [{ approverIds: { has: userId } }, ...(me?.role ? [{ approverRole: me.role }] : [])] };
  const [waiting, decided] = await Promise.all([
    db.approvalRequest.findMany({ where: { ...mine, status: "PENDING" }, orderBy: { expiresAt: "asc" }, take }),
    db.approvalRequest.findMany({ where: { ...mine, status: { not: "PENDING" } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return { waiting, decided };
}
