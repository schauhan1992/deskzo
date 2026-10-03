"use server";

import { revalidatePath } from "next/cache";
import type { CallOutcome, CallDirection, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { canSeeCompany, viaCompanyScope } from "@/lib/authz/company-scope";
import { callOutcomeValues, isConnected } from "@/lib/calls";
import type { ActionResult } from "@/actions/company";
import { viewerHas } from "@/actions/permission";
import { workspaceClock } from "@/lib/time/workspace";

const callSelect = {
  id: true,
  phoneNumber: true,
  direction: true,
  outcome: true,
  startedAt: true,
  durationSeconds: true,
  notes: true,
  followUpAt: true,
  followUpDone: true,
  createdAt: true,
  company: { select: { id: true, name: true, relationshipType: true } },
  contact: { select: { id: true, name: true, designation: true } },
  lead: { select: { id: true, title: true } },
  ticket: { select: { id: true, ticketSeq: true, title: true } },
  companyProduct: { select: { id: true, orderSeq: true, item: { select: { name: true } } } },
  user: { select: { id: true, name: true } },
} satisfies Prisma.CallLogSelect;

/**
 * Records a call.
 *
 * Everything except the company and the outcome is optional, deliberately: a caller who has just
 * put the phone down will log what happened if it takes five seconds, and will stop logging
 * entirely if the form insists on a duration and a note every time.
 */
export async function logCall(input: {
  companyId: string;
  contactId?: string;
  phoneNumber: string;
  outcome: string;
  direction?: string;
  startedAt?: string;
  durationSeconds?: number | string;
  notes?: string;
  followUpAt?: string;
  leadId?: string;
  ticketId?: string;
  companyProductId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("calls");

  if (!callOutcomeValues.includes(input.outcome as CallOutcome)) {
    return { ok: false, error: "Pick how the call went." };
  }
  const phoneNumber = input.phoneNumber?.trim();
  if (!phoneNumber) return { ok: false, error: "A call needs the number that was dialled." };

  const company = await db.company.findUnique({ where: { id: input.companyId }, select: { id: true, name: true } });
  if (!company) return { ok: false, error: "That company no longer exists." };

  if (input.contactId) {
    const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true } });
    if (!contact || contact.companyId !== company.id) {
      return { ok: false, error: "That contact doesn't belong to this company." };
    }
  }

  const duration = Math.max(0, Math.round(Number(input.durationSeconds) || 0));
  // A time typed into the dialog is the workspace's time, wherever the server is; one a page worked out
  // and sent with its zone is taken as it says.
  const clock = await workspaceClock();
  const startedAt = input.startedAt ? clock.parseTyped(input.startedAt) : new Date();
  if (!startedAt) return { ok: false, error: "That start time isn't a valid date." };

  const followUpAt = input.followUpAt ? clock.parseTyped(input.followUpAt) : null;
  if (input.followUpAt && !followUpAt) {
    return { ok: false, error: "That callback time isn't a valid date." };
  }

  const contactName = input.contactId
    ? (await db.contact.findUnique({ where: { id: input.contactId }, select: { name: true } }))?.name ?? null
    : null;

  const call = await db.$transaction(async (tx) => {
    const created = await tx.callLog.create({
      data: {
        companyId: company.id,
        contactId: input.contactId || null,
        leadId: input.leadId || null,
        ticketId: input.ticketId || null,
        companyProductId: input.companyProductId || null,
        phoneNumber,
        direction: (input.direction as CallDirection) ?? "OUTBOUND",
        outcome: input.outcome as CallOutcome,
        startedAt,
        durationSeconds: duration,
        notes: input.notes?.trim() || null,
        followUpAt,
        userId: user.id,
      },
      select: { id: true },
    });

    if (followUpAt) {
      // Assigned to whoever made the promise — a callback is owed by the person who gave their word,
      // not by whoever happens to own the account.
      const task = await tx.task.create({
        data: {
          title: `Call back ${contactName ?? company.name}${contactName ? ` at ${company.name}` : ""}`,
          description: input.notes?.trim()
            ? `Promised on the call: ${input.notes.trim()}`
            : `Promised during a call to ${phoneNumber}.`,
          dueDate: followUpAt,
          assignedToUserId: user.id,
          createdByUserId: user.id,
          companyId: company.id,
          leadId: input.leadId || null,
          ticketId: input.ticketId || null,
        },
        select: { id: true },
      });
      await tx.callLog.update({ where: { id: created.id }, data: { followUpTaskId: task.id } });
    }

    return created;
  });

  // A call against a lead is also part of that lead's story, so it goes on the timeline the lead
  // page already shows rather than being visible only under Calls.
  if (input.leadId) {
    await db.activity
      .create({
        data: {
          leadId: input.leadId,
          userId: user.id,
          type: "CALL",
          notes: `${input.outcome.replaceAll("_", " ").toLowerCase()}${input.notes ? ` — ${input.notes.trim()}` : ""}`,
          occurredAt: startedAt,
        },
      })
      .catch(() => null);
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "CallLog",
    entityId: call.id,
    entityLabel: `Call to ${company.name} — ${input.outcome.replaceAll("_", " ").toLowerCase()}`,
  });

  revalidatePath("/calls");
  if (followUpAt) revalidatePath("/tasks");
  revalidatePath(`/companies/${company.id}`);
  if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
  if (input.ticketId) revalidatePath(`/tickets/${input.ticketId}`);
  return { ok: true, data: call };
}

/** Marks a promised callback as done, without deleting the promise that was made. */
export async function completeFollowUp(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("calls");
  const call = await db.callLog.findUnique({ where: { id }, select: { id: true, followUpAt: true, followUpTaskId: true } });
  if (!call) return { ok: false, error: "That call no longer exists." };
  if (!call.followUpAt) return { ok: false, error: "There's no callback set on that call." };

  await db.$transaction(async (tx) => {
    await tx.callLog.update({ where: { id }, data: { followUpDone: true } });
    if (call.followUpTaskId) {
      await tx.task.update({
        where: { id: call.followUpTaskId },
        data: { done: true, doneAt: new Date() },
      });
    }
  });
  revalidatePath("/calls");
  revalidatePath("/tasks");
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "CallLog", entityId: id, entityLabel: "Callback done" });
  return { ok: true, data: null };
}

/**
 * The numbers a caller can reach this company on, primary contact first.
 *
 * Contacts only — a company has no number of its own in this model, and offering an empty
 * switchboard field would just be a box to ignore.
 */
export async function listCompanyNumbers(companyId: string) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return [];

  /**
   * Never a reseller's end customer.
   *
   * `src/lib/reseller.ts` states the rule the whole arrangement rests on — no direct calls, no
   * direct email — and this handed back the phone numbers and addresses anyway, to a dialler.
   * Enforced here rather than trusted to the caller: this is the one function in the module whose
   * entire output is contact details.
   */
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { managedByResellerId: true, ownerUserId: true },
  });
  if (!company || company.managedByResellerId) return [];

  /**
   * And never an account somebody does not manage.
   *
   * A separate rule from the one above and stacked on purpose: the reseller check asks whether
   * *anybody here* may ring this customer, the account scope asks whether *this* person may. The id
   * arrives from the caller, so there is nothing to filter — refuse, as `canSeeCompany` exists for.
   * Same empty result as a reseller's customer, so the dialler cannot tell the two apart.
   */
  if (!(await canSeeCompany(user.id, company.ownerUserId))) return [];

  const contacts = await db.contact.findMany({
    where: { companyId, phone: { not: null } },
    orderBy: [{ isPrimary: "desc" }, { name: "asc" }],
    select: { id: true, name: true, designation: true, phone: true, email: true, isPrimary: true },
  });
  return toPlain(contacts);
}

export async function listCalls(params: {
  page: number;
  pageSize: number;
  search?: string;
  outcome?: string;
  userId?: string;
  from?: string;
  to?: string;
  /** "due" narrows to callbacks that are promised and not yet done. */
  view?: string;
}) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return { rows: [], total: 0 };

  // From and To are the workspace's days.
  const days = (await workspaceClock()).dayRange(params.from, params.to);
  const where: Prisma.CallLogWhereInput = {
    /**
     * Scoped by the account, not by the caller.
     *
     * `CallLog.companyId` is required, so every call hangs off a company and the account manager of
     * that company is who it belongs to — the one-hop `company.ownerUserId` path, same as leads and
     * tickets. There is no "whose calls" permission to weigh this against: the `userId` parameter
     * here is a filter the floor manager chooses, never a restriction. What leaks without this is
     * the number dialled and the note taken afterwards, which are the customer's, not the caller's.
     */
    ...(await viaCompanyScope(user.id)),
    ...(params.outcome && callOutcomeValues.includes(params.outcome as CallOutcome)
      ? { outcome: params.outcome as CallOutcome }
      : {}),
    ...(params.userId ? { userId: params.userId } : {}),
    ...(params.view === "due" ? { followUpAt: { not: null }, followUpDone: false } : {}),
    ...(days ? { startedAt: days } : {}),
    ...(params.search
      ? {
          OR: [
            { company: { name: { contains: params.search, mode: "insensitive" } } },
            { contact: { name: { contains: params.search, mode: "insensitive" } } },
            { phoneNumber: { contains: params.search } },
            { notes: { contains: params.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.callLog.findMany({
      where,
      // Due callbacks read soonest-first; everything else newest-first.
      orderBy: params.view === "due" ? { followUpAt: "asc" } : { startedAt: "desc" },
      skip: (params.page - 1) * params.pageSize,
      take: params.pageSize,
      select: callSelect,
    }),
    db.callLog.count({ where }),
  ]);

  return toPlain({ rows, total });
}

/** Headline figures for the calling team: dials, how many reached a person, and time on the phone. */
export async function callSummary(params?: { from?: string; to?: string; userId?: string }) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return { total: 0, connected: 0, connectRate: 0, talkTimeSeconds: 0, companiesReached: 0, dueCallbacks: 0 };
  // Today unless told otherwise — the workspace's today, not the server's: on a server in UTC, a team in
  // India had a day that began at 05:30.
  const clock = await workspaceClock();
  const today = clock.today();
  const days = clock.dayRange(params?.from || today, params?.to || today) ?? {};

  // Both queries, not just the first. The overdue-callback tally is a second read of the same table
  // and counts the whole business unless it is scoped too — a number nobody would think to doubt,
  // and one that tells a sales executive how many customers they cannot see are waiting on a call.
  const scope = await viaCompanyScope(user.id);

  const [calls, dueCount] = await Promise.all([
    db.callLog.findMany({
      where: { ...scope, startedAt: days, ...(params?.userId ? { userId: params.userId } : {}) },
      select: { outcome: true, durationSeconds: true, companyId: true },
    }),
    db.callLog.count({ where: { ...scope, followUpAt: { not: null, lte: new Date() }, followUpDone: false } }),
  ]);

  const connected = calls.filter((c) => isConnected(c.outcome)).length;
  return {
    total: calls.length,
    connected,
    // The figure a floor manager actually watches — dialling more doesn't help if nobody answers.
    connectRate: calls.length > 0 ? Math.round((connected / calls.length) * 100) : 0,
    talkTimeSeconds: calls.reduce((t, c) => t + c.durationSeconds, 0),
    companiesReached: new Set(calls.filter((c) => isConnected(c.outcome)).map((c) => c.companyId)).size,
    dueCallbacks: dueCount,
  };
}

/** A company's call history, for the 360 view. */
export async function listCompanyCalls(companyId: string, take = 50) {
  const user = await requireModuleUser("calls");
  if (!(await viewerHas("calls.view"))) return [];
  return toPlain(
    await db.callLog.findMany({
      // Scoped as well as filtered by id. Every row here shares one company, so the scope is
      // all-or-nothing and reads as the refusal it is: without it, a company id — which is not a
      // secret — is enough to read the call notes on an account somebody else manages.
      where: { ...(await viaCompanyScope(user.id)), companyId },
      orderBy: { startedAt: "desc" },
      take,
      select: callSelect,
    }),
  );
}

/**
 * The names in the "caller" filter. Our own staff, so deliberately not account-scoped: narrowing it
 * to colleagues who happened to ring your accounts would hide nothing a customer owns and would
 * leave the filter offering a different set of names on every page.
 */
export async function listCallers() {
  await requireModuleUser("calls");
  return db.user.findMany({
    where: { active: true, callsLogged: { some: {} } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}
