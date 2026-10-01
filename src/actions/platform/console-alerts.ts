"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { alertKeyInfo, alertTenantId } from "@/lib/platform/alerts";
import { WRITERS, cleanText, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Acknowledging the console's alerts (src/lib/platform/alerts.ts), and putting them off — for everybody
 * who changes anything (WRITERS), so the team can see an alert is being handled.
 *
 *   · An instance alert (one failed setup, one webhook) may be acknowledged for good: a new occurrence
 *     has a key of its own and shows again.
 *   · A condition ("the warm pool is low") can only be put off, for 1 hour to 7 days, and shows again
 *     then if it is still true.
 *
 * Nothing but the acknowledgement changes, and each one is in the platform audit log.
 */

const MAX_SNOOZE_HOURS = 168;
const MAX_NOTE = 300;

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

/** The key as the browser sent it, checked against the kinds of alert the console raises. */
function alertKey(input: unknown): { key: string; instance: boolean } {
  const key = typeof input === "string" ? input.trim() : "";
  const info = alertKeyInfo(key);
  if (!info.valid) throw new ConsoleRefused("That is not an alert the console raises.");
  return { key, instance: info.instance };
}

/** The workspace an alert is about, when its key names one that exists — so the audit entry shows on that workspace's page too. */
async function workspaceOf(key: string): Promise<string | null> {
  const id = alertTenantId(key);
  if (!id) return null;
  const tenant = await controlDb().tenant.findUnique({ where: { id }, select: { id: true } });
  return tenant?.id ?? null;
}

/**
 * Acknowledges an alert for good (`snoozeHours` left out — instance alerts only), or puts it off for
 * `snoozeHours` (1–168). `note`, up to 300 characters, says what is being done about it.
 */
export async function consoleAckAlert(key: string, opts: { snoozeHours?: number; note?: string }): Promise<ConsoleResult<{ snoozeUntil: string | null }>> {
  return asStaff(WRITERS, async (staff) => {
    const alert = alertKey(key);
    const options: { snoozeHours?: unknown; note?: unknown } = opts && typeof opts === "object" ? opts : {};

    let hours: number | null = null;
    const raw = options.snoozeHours;
    if (raw !== undefined && raw !== null && !(typeof raw === "string" && raw.trim() === "")) {
      const n = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > MAX_SNOOZE_HOURS) throw new ConsoleRefused("Put it off for between 1 hour and 7 days.");
      hours = n;
    }
    if (hours === null && !alert.instance) throw new ConsoleRefused("This one can only be put off.");

    const note = cleanText(options.note, MAX_NOTE * 4);
    if (note.length > MAX_NOTE) throw new ConsoleRefused(`Keep the note to ${MAX_NOTE} characters.`);

    const now = new Date();
    const snoozeUntil = hours === null ? null : new Date(now.getTime() + hours * 3_600_000);
    const data = { ackedBy: staff.id, ackedAt: now, snoozeUntil, note: note || null };
    await controlDb().platformAlertAck.upsert({ where: { key: alert.key }, create: { key: alert.key, ...data }, update: data, select: { key: true } });
    await consoleAudit(staff, "alert.ack", { key: alert.key, snoozeUntil: snoozeUntil ? snoozeUntil.toISOString() : null, note: note || null }, await workspaceOf(alert.key));
    revalidateConsole();
    return { snoozeUntil: snoozeUntil ? snoozeUntil.toISOString() : null };
  });
}

/** Reopens an acknowledged or put-off alert: it shows again at once if it is still true. */
export async function consoleUnackAlert(key: string): Promise<ConsoleResult<null>> {
  return asStaff(WRITERS, async (staff) => {
    const alert = alertKey(key);
    const { count } = await controlDb().platformAlertAck.deleteMany({ where: { key: alert.key } });
    // Already reopened (by somebody else, or a second click): nothing changed, so nothing to record.
    if (count > 0) await consoleAudit(staff, "alert.unack", { key: alert.key }, await workspaceOf(alert.key));
    revalidateConsole();
    return null;
  });
}
