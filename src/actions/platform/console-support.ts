"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { MANAGERS, SUPPORT_AGENTS } from "@/lib/console-shared/roles";
import { platformBrandName } from "@/lib/platform/brand";
import { consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { deliver, replyMail } from "@/lib/support/mail";
import { plainText } from "@/lib/support/requests";
import { getSupportSettings, saveSupportSettingsValues, validateSupportSettings } from "@/lib/support/settings";
import {
  LIMITS,
  SUPPORT_PRIORITIES,
  SUPPORT_STATUSES,
  type SupportPriorityKey,
  type SupportSettingsInput,
  type SupportSettingsView,
  type SupportStatusKey,
} from "@/lib/support/types";

/**
 * Working support requests from the console's Support page: replying (emailed to the requester),
 * internal notes, status, priority and assignee — and the Support section of Settings.
 *
 *   · OWNER, ADMIN and SUPPORT act on requests (SUPPORT_AGENTS); READONLY only reads them. Settings
 *     are for owners and admins.
 *   · Every change writes an entry on the request's timeline and a platform audit row. The audit row
 *     holds numbers, ids, lengths and states — never what anybody wrote.
 *   · A reply is emailed with Reply-To: the support address. There is no inbound mail: the customer's
 *     answer reaches the support mailbox, not this page (the reply form says so).
 *
 * Support access to a workspace is not given here, or anywhere in the console — only its super admin
 * gives it, from inside the workspace.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

const GONE = "That support request no longer exists.";
const chars = (s: string) => [...s].length;

/** A request number from the browser (1042, "1042"); a refusal for anything else. */
function numberOf(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ConsoleRefused(GONE);
  return n;
}

const REQUEST_SELECT = {
  id: true,
  number: true,
  tenantId: true,
  subject: true,
  status: true,
  priority: true,
  assigneeId: true,
  requesterName: true,
  requesterEmail: true,
  firstResponseAt: true,
  resolvedAt: true,
} as const;

async function requestByNumber(value: unknown) {
  const row = await controlDb().supportRequest.findUnique({ where: { number: numberOf(value) }, select: REQUEST_SELECT });
  if (!row) throw new ConsoleRefused(GONE);
  return row;
}

/** A reply's or a note's text: plain, line breaks kept, 1–5000 characters. */
function messageOf(value: unknown, what: "reply" | "note"): string {
  const text = plainText(value);
  if (!text) throw new ConsoleRefused(what === "reply" ? "Write the reply first." : "Write the note first.");
  if (chars(text) > LIMITS.body) throw new ConsoleRefused(`Keep the ${what} to ${LIMITS.body.toLocaleString("en-IN")} characters.`);
  return text;
}

/**
 * Emails a reply to the requester (Reply-To: the support address; "Re: [SR-1042] {subject}") and
 * keeps it on the timeline, marked emailed or with why it wasn't. The first reply that reaches them
 * sets the first-response time; a request still Open moves to In progress. Returns whether it went.
 */
export async function replySupport(number: number, body: string): Promise<ConsoleResult<{ emailed: boolean; error: string | null }>> {
  return asStaff(SUPPORT_AGENTS, async (staff) => {
    const text = messageOf(body, "reply");
    const r = await requestByNumber(number);
    const [settings, brandName] = await Promise.all([getSupportSettings(), platformBrandName()]);
    const sent = await deliver(
      replyMail({
        number: r.number,
        subject: r.subject,
        body: text,
        requester: { name: r.requesterName, email: r.requesterEmail },
        staffName: staff.name,
        brandName,
        supportEmail: settings.email,
      }),
      "reply",
      r.number,
    );
    const now = new Date();
    const moved = await controlDb().$transaction(async (tx) => {
      await tx.supportEntry.create({
        data: { requestId: r.id, kind: "REPLY", body: text, authorId: staff.id, meta: { emailed: sent.ok, to: r.requesterEmail, ...(sent.ok ? {} : { error: sent.error }) } },
        select: { id: true },
      });
      if (sent.ok) await tx.supportRequest.updateMany({ where: { id: r.id, firstResponseAt: null }, data: { firstResponseAt: now } });
      const progressed = await tx.supportRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "IN_PROGRESS" } });
      if (progressed.count > 0) {
        await tx.supportEntry.create({ data: { requestId: r.id, kind: "STATUS", authorId: staff.id, meta: { from: "OPEN", to: "IN_PROGRESS" } }, select: { id: true } });
      }
      // The inbox's last activity, whatever else changed.
      await tx.supportRequest.update({ where: { id: r.id }, data: { updatedAt: now }, select: { id: true } });
      return progressed.count > 0;
    });
    await consoleAudit(staff, "support.reply", { number: r.number, requestId: r.id, length: chars(text), emailed: sent.ok, ...(moved ? { status: "IN_PROGRESS" } : {}) }, r.tenantId);
    revalidateConsole();
    return { emailed: sent.ok, error: sent.ok ? null : sent.error };
  });
}

/** An internal note: on the timeline for staff, never sent anywhere. */
export async function noteSupport(number: number, body: string): Promise<ConsoleResult<null>> {
  return asStaff(SUPPORT_AGENTS, async (staff) => {
    const text = messageOf(body, "note");
    const r = await requestByNumber(number);
    const now = new Date();
    await controlDb().$transaction(async (tx) => {
      await tx.supportEntry.create({ data: { requestId: r.id, kind: "NOTE", body: text, authorId: staff.id }, select: { id: true } });
      await tx.supportRequest.update({ where: { id: r.id }, data: { updatedAt: now }, select: { id: true } });
    });
    await consoleAudit(staff, "support.note", { number: r.number, requestId: r.id, length: chars(text) }, r.tenantId);
    revalidateConsole();
    return null;
  });
}

/**
 * Moves a request to a status. Resolved stamps when it was resolved; Closed stamps when it was closed
 * (and resolved, if it never was) — retention counts from the close. Back to Open, In progress or
 * Waiting clears both: it is not done after all, and its files are kept again.
 */
export async function setSupportStatus(number: number, status: SupportStatusKey): Promise<ConsoleResult<null>> {
  return asStaff(SUPPORT_AGENTS, async (staff) => {
    if (!(SUPPORT_STATUSES as readonly string[]).includes(status)) throw new ConsoleRefused("Choose a status.");
    const r = await requestByNumber(number);
    if (r.status === status) return null;
    const now = new Date();
    const stamps =
      status === "RESOLVED"
        ? { resolvedAt: now, closedAt: null }
        : status === "CLOSED"
          ? { resolvedAt: r.resolvedAt ?? now, closedAt: now }
          : { resolvedAt: null, closedAt: null };
    await controlDb().$transaction(async (tx) => {
      // Only from the status it was read in: two people changing it at once can't both write "from".
      const done = await tx.supportRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status, ...stamps } });
      if (done.count === 0) throw new ConsoleRefused("Someone changed it a moment ago — refresh and try again.");
      await tx.supportEntry.create({ data: { requestId: r.id, kind: "STATUS", authorId: staff.id, meta: { from: r.status, to: status } }, select: { id: true } });
    });
    await consoleAudit(staff, "support.status", { number: r.number, requestId: r.id, from: r.status, to: status }, r.tenantId);
    revalidateConsole();
    return null;
  });
}

export async function setSupportPriority(number: number, priority: SupportPriorityKey): Promise<ConsoleResult<null>> {
  return asStaff(SUPPORT_AGENTS, async (staff) => {
    if (!(SUPPORT_PRIORITIES as readonly string[]).includes(priority)) throw new ConsoleRefused("Choose a priority.");
    const r = await requestByNumber(number);
    if (r.priority === priority) return null;
    await controlDb().$transaction(async (tx) => {
      const done = await tx.supportRequest.updateMany({ where: { id: r.id, priority: r.priority }, data: { priority } });
      if (done.count === 0) throw new ConsoleRefused("Someone changed it a moment ago — refresh and try again.");
      await tx.supportEntry.create({ data: { requestId: r.id, kind: "PRIORITY", authorId: staff.id, meta: { from: r.priority, to: priority } }, select: { id: true } });
    });
    await consoleAudit(staff, "support.priority", { number: r.number, requestId: r.id, from: r.priority, to: priority }, r.tenantId);
    revalidateConsole();
    return null;
  });
}

/** Assigns a request to a staff member who acts on requests (active: OWNER, ADMIN or SUPPORT), or to nobody (null). */
export async function assignSupport(number: number, staffId: string | null): Promise<ConsoleResult<null>> {
  return asStaff(SUPPORT_AGENTS, async (staff) => {
    const to = staffId === null || staffId === undefined || staffId === "" ? null : typeof staffId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(staffId) ? staffId : undefined;
    if (to === undefined) throw new ConsoleRefused("Choose a staff member.");
    const control = controlDb();
    const r = await requestByNumber(number);
    if (r.assigneeId === to) return null;
    const [target, previous] = await Promise.all([
      to ? control.platformUser.findUnique({ where: { id: to }, select: { id: true, name: true, role: true, active: true } }) : Promise.resolve(null),
      r.assigneeId ? control.platformUser.findUnique({ where: { id: r.assigneeId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    if (to && (!target || !target.active || !(SUPPORT_AGENTS as readonly string[]).includes(target.role))) {
      throw new ConsoleRefused("Choose a staff member who works on support requests.");
    }
    await control.$transaction(async (tx) => {
      const done = await tx.supportRequest.updateMany({ where: { id: r.id, assigneeId: r.assigneeId }, data: { assigneeId: to } });
      if (done.count === 0) throw new ConsoleRefused("Someone changed it a moment ago — refresh and try again.");
      await tx.supportEntry.create({
        data: { requestId: r.id, kind: "ASSIGN", authorId: staff.id, meta: { from: r.assigneeId, to, fromName: previous?.name ?? null, toName: target?.name ?? null } },
        select: { id: true },
      });
    });
    await consoleAudit(staff, "support.assign", { number: r.number, requestId: r.id, from: r.assigneeId, to, toName: target?.name ?? null }, r.tenantId);
    revalidateConsole();
    return null;
  });
}

/**
 * The Support section of Settings: the switch, the support address, the helpline and its hours,
 * recording, and how long closed requests' files are kept. Owners and admins. The audit row says what
 * was switched and whether the text fields changed — not what they say.
 */
export async function saveSupportSettings(input: SupportSettingsInput): Promise<ConsoleResult<SupportSettingsView>> {
  return asStaff(MANAGERS, async (staff) => {
    const next = validateSupportSettings(input);
    const before = await getSupportSettings();
    await saveSupportSettingsValues(next, staff.id);
    await consoleAudit(staff, "support.settings", {
      enabled: next.enabled,
      recording: next.recording,
      retentionDays: next.retentionDays,
      emailChanged: next.email !== before.email,
      helplineChanged: next.helpline !== before.helpline,
      hoursChanged: next.hours !== before.hours,
    });
    revalidateConsole();
    return next;
  });
}
