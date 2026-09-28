"use server";

import type { StaffRole } from "@wroffy/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { parseAuditFilters, type AuditFilters, type RawParams } from "@/lib/console-shared/params";
import type { CsvExport } from "@/lib/console-shared/types";
import { auditCsv } from "@/lib/platform/audit-query";
import { ALL_ROLES, MANAGERS, OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { ConsoleRefused } from "@/lib/platform/refused";
import { endStaffSession, issuePasswordSetup, listStaffSessions, reactivateStaff } from "@/lib/platform/staff";
import { StaffRefused, currentStaffSession, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * The console's staff, account, audit-export and invitation actions (spec §5.9.4):
 *
 *   consoleEndStaffSession      OWNER     sign one of anybody's sessions out
 *   consoleEndMySession         anybody   sign one of one's own sessions out
 *   consoleEndMyOtherSessions   anybody   sign out everywhere but here
 *   consoleReactivateStaff      OWNER     switch a staff member back on (a new setup link, shown once)
 *   consoleMyPasswordLink       anybody   a password link, emailed to one's own address — never shown
 *   consoleExportAudit          managers  the filtered audit log as CSV (its detail holds email addresses)
 *   consoleExtendInvite         managers  more days for an invitation
 *
 * Each checks the role again itself, re-reads its inputs as untrusted, writes the audit log once for
 * what it changed (itself, or through the library that made the change) and refreshes the console.
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

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Self-service password links an hour, per staff member — each replaces the last, and each is an email. */
const SELF_LINKS_PER_HOUR = 3;
const SESSION_ENDED = "That session has already ended.";
const INVITE_GONE = "That invitation no longer exists.";

/** A session id is the SHA-256 of its cookie's token, in hex. Anything else names no session. */
function sessionIdOf(input: unknown): string {
  const id = String(input ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new ConsoleRefused(SESSION_ENDED);
  return id;
}

// ─── Sessions ────────────────────────────────────────────────────────────────────────────────────

/** Owners: sign one session out, anybody's. The library writes `staff.session.end`. */
export async function consoleEndStaffSession(sessionId: string): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    await endStaffSession(sessionIdOf(sessionId), staff.id);
    revalidateConsole();
    return null;
  });
}

/** Anybody: sign one of their own sessions out — somebody else's is refused as an ended one is. */
export async function consoleEndMySession(sessionId: string): Promise<ConsoleResult<null>> {
  return asStaff(ALL_ROLES, async (staff) => {
    await endStaffSession(sessionIdOf(sessionId), staff.id, staff.id);
    revalidateConsole();
    return null;
  });
}

/** Anybody: sign out everywhere but the session this request came with. `ended` counts the sessions that still let somebody in. */
export async function consoleEndMyOtherSessions(): Promise<ConsoleResult<{ ended: number }>> {
  return asStaff(ALL_ROLES, async (staff) => {
    const session = await currentStaffSession();
    // requireStaff has just read the same cookie; this only fails if it ended in between.
    if (!session || session.staff.id !== staff.id) throw new ConsoleRefused("Sign in to the console.");
    const now = new Date();
    const live = (await listStaffSessions(staff.id, now)).filter((s) => s.id !== session.sessionId).length;
    // Every one not yet ended, the long-idle ones too: nothing is left that could be picked up again.
    const revoked = await controlDb().platformSession.updateMany({ where: { userId: staff.id, revokedAt: null, NOT: { id: session.sessionId } }, data: { revokedAt: now } });
    if (revoked.count > 0) await consoleAudit(staff, "staff.sessions.end", { userId: staff.id, others: true, ended: live });
    revalidateConsole();
    return { ended: live };
  });
}

// ─── Staff ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Owners: switch a staff member back on. The setup link comes back to show once — it is also emailed
 * to them. Somebody already on is refused by the library, which writes `staff.reactivate`.
 */
export async function consoleReactivateStaff(userId: string): Promise<ConsoleResult<{ setupUrl: string }>> {
  return asStaff(OWNERS, async (staff) => {
    const id = String(userId ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConsoleRefused("That staff member no longer exists.");
    const result = await reactivateStaff(id, staff.id);
    revalidateConsole();
    return result;
  });
}

/**
 * Anybody: a link to choose a new password, emailed to their own address and never returned — a
 * session somebody else has taken over cannot turn it into the account. At most three an hour,
 * counted from the audit log.
 */
export async function consoleMyPasswordLink(): Promise<ConsoleResult<{ sentTo: string }>> {
  return asStaff(ALL_ROLES, async (staff) => {
    const control = controlDb();
    const recent = await control.platformAuditLog.count({
      where: { action: "staff.setup-link", actorKind: "STAFF", actor: staff.id, at: { gte: new Date(Date.now() - HOUR_MS) }, detail: { path: ["self"], equals: true } },
    });
    if (recent >= SELF_LINKS_PER_HOUR) throw new ConsoleRefused("You have asked for three password links in the last hour. Use the newest one, or try again later.");
    const url = await issuePasswordSetup(staff.id);
    await consoleAudit(staff, "staff.setup-link", { userId: staff.id, self: true });
    revalidateConsole();
    try {
      await sendPlatformMail({
        to: staff.email,
        subject: "Choose a new console password",
        text: [
          `Hello ${staff.name},`,
          "",
          "You asked for a link to choose a new password for the platform console. It works once, for three days, and replaces any link sent before:",
          "",
          url,
          "",
          "Choosing a password signs you out everywhere. If you did not ask for this, tell an owner — your password stays as it is until the link is used.",
        ].join("\n"),
      });
    } catch (err) {
      console.error("[console] the password link could not be emailed", err);
      throw new ConsoleRefused("The email could not be sent. Try again in a few minutes.");
    }
    return { sentTo: staff.email };
  });
}

// ─── Audit export ────────────────────────────────────────────────────────────────────────────────

/** The page's own filter params (`exportParams`), read as untrusted: strings only, a bounded few. */
function rawParamsOf(input: unknown): RawParams {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out: RawParams = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>).slice(0, 40)) {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(key)) out[key] = value.slice(0, 200);
  }
  return out;
}

/** Managers: the filtered audit log as CSV — every matching row, up to 10,000. Audited with the filters it used. */
export async function consoleExportAudit(params: Record<string, string>): Promise<ConsoleResult<CsvExport>> {
  return asStaff(MANAGERS, async (staff) => {
    const filters = parseAuditFilters(rawParamsOf(params));
    const exported = await auditCsv(filters);
    await consoleAudit(staff, "export.audit", { filters: exportedFilters(filters), rows: exported.rows });
    return exported;
  });
}

/** The filters an export applied — the cursor and page size play no part in one. */
function exportedFilters(f: AuditFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["q", "actorKind", "staff", "who", "action", "category", "tenant", "from", "to"] as const) {
    const value = f[key];
    if (typeof value === "string" && value) out[key] = value;
  }
  return out;
}

// ─── Invitations ─────────────────────────────────────────────────────────────────────────────────

/**
 * Managers: an invitation lasts `days` (1–90) longer — from its end, or from now if that has passed.
 * A used-up invitation is refused, and so is an ended one: ending it was a decision (a leaked code,
 * say), and extending must not quietly undo it. Only the hash's first 8 characters go in the log.
 */
export async function consoleExtendInvite(codeHash: string, days: number): Promise<ConsoleResult<{ expiresAt: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const hash = String(codeHash ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new ConsoleRefused(INVITE_GONE);
    const n = typeof days === "number" ? days : Number(String(days ?? "").trim());
    if (!Number.isInteger(n) || n < 1 || n > 90) throw new ConsoleRefused("Extend it by 1 to 90 days.");

    const control = controlDb();
    const now = new Date();
    const invite = await control.signupInvite.findUnique({ where: { codeHash: hash }, select: { uses: true, maxUses: true, expiresAt: true } });
    if (!invite) throw new ConsoleRefused(INVITE_GONE);
    if (invite.uses >= invite.maxUses) throw new ConsoleRefused("This invitation is used up. Create a new one instead.");
    if (!invite.expiresAt) throw new ConsoleRefused("This invitation has no end date to move.");
    const prefix = hash.slice(0, 8);
    if (invite.expiresAt.getTime() <= now.getTime()) {
      const ended = await control.platformAuditLog.findFirst({ where: { action: "invite.end", detail: { path: ["codeHashPrefix"], equals: prefix } }, select: { id: true } });
      if (ended) throw new ConsoleRefused("This invitation was ended. Create a new one instead.");
    }

    const expiresAt = new Date(Math.max(now.getTime(), invite.expiresAt.getTime()) + n * DAY_MS);
    // Only if nobody used or changed it since it was read: the refusals above were about this state.
    const moved = await control.signupInvite.updateMany({ where: { codeHash: hash, uses: invite.uses, expiresAt: invite.expiresAt }, data: { expiresAt } });
    if (moved.count !== 1) throw new ConsoleRefused("That invitation changed in the meantime. Reload the page and try again.");
    await consoleAudit(staff, "invite.extend", { codeHashPrefix: prefix, days: n });
    revalidateConsole();
    return { expiresAt: expiresAt.toISOString() };
  });
}
