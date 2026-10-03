"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import {
  ANNOUNCEMENT_AUDIENCES,
  announcementReach,
  checkAnnouncementTargets,
  forgetAnnouncements,
  validateAnnouncement,
  type AnnouncementAudienceKey,
} from "@/lib/platform/announcements";
import { consoleClock } from "@/lib/platform/console-clock";
import { MANAGERS, consoleAudit, consoleRefusal, idList, revalidateConsole } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";
import type { Clock } from "@/lib/time/zone";

/**
 * Platform announcements from the console — the banner across workspaces' pages
 * (src/lib/platform/announcements.ts). Owners and admins write them; only an owner may speak to every
 * workspace at once, and that, or a critical one nobody can dismiss, needs "publish" typed as well.
 *
 * Every change clears this process's cached copy; other servers pick it up within a minute. The audit
 * entry names the announcement, never its body.
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

const GONE = "That announcement no longer exists.";

/** An announcement id from the browser, or a refusal. */
function announcementId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ConsoleRefused(GONE);
  return id;
}

/** A `datetime-local` value, read on the console's clock; undefined when blank. */
function timeInput(value: unknown, what: "start" | "end", clock: Clock): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  const at = text.length <= 32 ? clock.parseInput(text) : null;
  if (!at) throw new ConsoleRefused(`Enter the ${what} as a date and time.`);
  return at;
}

/**
 * Creates an announcement, or saves changes to one (`id`). Start blank: now for a new one, unchanged for
 * an edit. An archived one can't be edited — duplicate it instead.
 */
export async function consoleSaveAnnouncement(input: {
  id?: string;
  title: string;
  body: string;
  tone: string;
  audience: string;
  targets: string[];
  startsAt?: string;
  endsAt?: string;
  dismissible: boolean;
  confirm?: string;
}): Promise<ConsoleResult<{ id: string }>> {
  return asStaff(MANAGERS, async (staff) => {
    const raw: Record<string, unknown> = input && typeof input === "object" ? input : {};
    const control = controlDb();
    const now = new Date();
    const clock = await consoleClock();

    const id = raw.id === undefined || raw.id === null || raw.id === "" ? null : announcementId(raw.id);
    const existing = id ? await control.platformAnnouncement.findUnique({ where: { id }, select: { id: true, startsAt: true, archivedAt: true } }) : null;
    if (id && !existing) throw new ConsoleRefused(GONE);
    if (existing?.archivedAt) throw new ConsoleRefused("An archived announcement can't be edited — duplicate it instead.");

    const valid = validateAnnouncement(
      {
        title: raw.title,
        body: raw.body,
        tone: raw.tone,
        audience: raw.audience,
        targets: Array.isArray(raw.targets) ? raw.targets : [],
        startsAt: timeInput(raw.startsAt, "start", clock) ?? existing?.startsAt,
        endsAt: timeInput(raw.endsAt, "end", clock),
        dismissible: raw.dismissible === true,
      },
      now,
    );

    if (valid.audience === "ALL" && staff.role !== "OWNER") throw new ConsoleRefused("Only an owner can announce to every workspace.");
    if ((valid.audience === "ALL" || valid.tone === "CRITICAL") && String(raw.confirm ?? "").trim() !== "publish") {
      throw new ConsoleRefused(valid.audience === "ALL" ? "Type publish to send it to every workspace." : "Type publish to put up a critical announcement.");
    }
    await checkAnnouncementTargets(valid.audience, valid.targets);

    let savedId: string;
    if (existing) {
      // Archived since it was read: refused rather than brought back to life.
      const done = await control.platformAnnouncement.updateMany({ where: { id: existing.id, archivedAt: null }, data: { ...valid, updatedBy: staff.id } });
      if (done.count === 0) throw new ConsoleRefused("It was archived meanwhile — duplicate it instead.");
      savedId = existing.id;
    } else {
      savedId = (await control.platformAnnouncement.create({ data: { ...valid, createdBy: staff.id }, select: { id: true } })).id;
    }

    await consoleAudit(staff, existing ? "announcement.update" : "announcement.create", {
      id: savedId,
      title: valid.title,
      tone: valid.tone,
      audience: valid.audience,
      targets: valid.targets.length,
      startsAt: valid.startsAt.toISOString(),
      endsAt: valid.endsAt ? valid.endsAt.toISOString() : null,
    });
    forgetAnnouncements();
    revalidateConsole();
    return { id: savedId };
  });
}

/** Takes a live announcement down now: it ends this second, and stays in Ended. */
export async function consoleEndAnnouncement(id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const control = controlDb();
    const now = new Date();
    const row = await control.platformAnnouncement.findUnique({
      where: { id: announcementId(id) },
      select: { id: true, title: true, startsAt: true, endsAt: true, archivedAt: true },
    });
    if (!row) throw new ConsoleRefused(GONE);
    if (row.archivedAt) throw new ConsoleRefused("It is archived, so it isn't showing anywhere.");
    if (row.startsAt.getTime() > now.getTime()) throw new ConsoleRefused("It hasn't started yet — archive it instead.");
    if (row.endsAt && row.endsAt.getTime() <= now.getTime()) throw new ConsoleRefused("It has already ended.");

    // The window must stay the right way round (endsAt > startsAt, a CHECK in the database).
    const startsAt = new Date(Math.min(row.startsAt.getTime(), now.getTime() - 1000));
    const done = await control.platformAnnouncement.updateMany({
      where: { id: row.id, archivedAt: null, endsAt: row.endsAt },
      data: { endsAt: now, startsAt, updatedBy: staff.id },
    });
    if (done.count === 0) throw new ConsoleRefused("It changed meanwhile — reload and try again.");

    await consoleAudit(staff, "announcement.end", { id: row.id, title: row.title });
    forgetAnnouncements();
    revalidateConsole();
    return null;
  });
}

/** Files it away: it stops showing (if it still was) and moves to Archived. */
export async function consoleArchiveAnnouncement(id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const control = controlDb();
    const row = await control.platformAnnouncement.findUnique({ where: { id: announcementId(id) }, select: { id: true, title: true, archivedAt: true } });
    if (!row) throw new ConsoleRefused(GONE);
    if (row.archivedAt) throw new ConsoleRefused("It is already archived.");

    const done = await control.platformAnnouncement.updateMany({ where: { id: row.id, archivedAt: null }, data: { archivedAt: new Date(), updatedBy: staff.id } });
    if (done.count === 0) throw new ConsoleRefused("It is already archived.");

    await consoleAudit(staff, "announcement.archive", { id: row.id, title: row.title });
    forgetAnnouncements();
    revalidateConsole();
    return null;
  });
}

/** The editor's live preview: how many open workspaces an audience reaches, and a few of them. A read — not audited. */
export async function consoleAnnouncementReach(audience: string, targets: string[]): Promise<ConsoleResult<{ count: number; sample: string[] }>> {
  return asStaff(MANAGERS, async () => {
    const key = String(audience ?? "").trim().toUpperCase();
    if (!(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(key)) throw new ConsoleRefused("Choose who it is for.");
    const list = idList(targets, 200);
    if (list === null) throw new ConsoleRefused("Choose at most 200.");
    return announcementReach(key as AnnouncementAudienceKey, list);
  });
}
