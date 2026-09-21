"use server";

import { revalidatePath } from "next/cache";
import type { CelebrationAudience, CelebrationKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { hasEffectivePermission } from "@/actions/permission";
import { dateOnly } from "@/lib/hr/calendar";
import { checkUpload } from "@/lib/hr/document-upload";
import type { ActionResult } from "@/actions/company";

/**
 * Greetings and occasions.
 *
 * Reading what to show today lives in src/lib/hr/today.ts, so the layout and the dashboard page can
 * share one query pass. What is here is everything that writes: dismissing a greeting, and the
 * occasions HR writes by hand.
 */

async function requireHr() {
  const user = await requireUser();
  return { user, allowed: await hasEffectivePermission(user.id, "hr.manage") };
}

/**
 * Records that this person has seen this occasion.
 *
 * Server side rather than in the browser, so closing the greeting on a laptop also closes it on a
 * phone. The key is opaque and self-issued, which is safe precisely because it only ever suppresses
 * something *for the person calling it* — the worst a forged key can do is hide a greeting from
 * yourself.
 */
export async function dismissMoment(occasionKey: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!occasionKey || occasionKey.length > 200) return { ok: false, error: "Unknown occasion." };
  await db.celebrationSeen.upsert({
    where: { userId_occasionKey: { userId: user.id, occasionKey } },
    create: { userId: user.id, occasionKey },
    update: {},
  });
  return { ok: true, data: null };
}

// ─── Authoring ────────────────────────────────────────────────────────────────

export async function listCelebrations() {
  const { allowed } = await requireHr();
  if (!allowed) return [];
  return toPlain(
    await db.celebration.findMany({
      orderBy: [{ startsOn: "desc" }],
      take: 100,
      include: {
        subject: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        createdBy: { select: { name: true } },
      },
    }),
  );
}

export async function saveCelebration(input: {
  id?: string;
  kind: CelebrationKind;
  audience: CelebrationAudience;
  title: string;
  message?: string;
  accent?: string;
  subjectUserId?: string;
  departmentId?: string;
  startsOn: string;
  endsOn: string;
  active?: boolean;
  image?: { name: string; fileDataUrl: string; mimeType: string } | null;
}): Promise<ActionResult<{ id: string }>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can post a celebration." };

  const title = input.title.trim();
  if (!title) return { ok: false, error: "Give it a title — it is the line people will read." };

  const startsOn = dateOnly(input.startsOn);
  const endsOn = dateOnly(input.endsOn);
  if (endsOn < startsOn) return { ok: false, error: "It can't finish before it starts." };

  if (input.audience === "PERSON" && !input.subjectUserId) {
    return { ok: false, error: "Choose who this is for." };
  }
  if (input.audience === "DEPARTMENT" && !input.departmentId) {
    return { ok: false, error: "Choose which team sees this." };
  }

  let imageDataUrl: string | null | undefined;
  if (input.image) {
    const check = checkUpload(input.image);
    if (!check.ok) return { ok: false, error: check.error };
    if (!input.image.mimeType.startsWith("image/")) {
      return { ok: false, error: "The splash image has to be an image." };
    }
    imageDataUrl = input.image.fileDataUrl;
  } else if (input.image === null) {
    imageDataUrl = null;
  }

  const data = {
    kind: input.kind,
    audience: input.audience,
    title,
    message: input.message?.trim() || null,
    accent: input.accent?.trim() || null,
    // Kept whatever the audience: an achievement posted to EVERYONE is still *about* somebody,
    // and their name is what makes it worth reading.
    subjectUserId: input.subjectUserId || null,
    departmentId: input.audience === "DEPARTMENT" ? input.departmentId! : null,
    startsOn,
    endsOn,
    active: input.active ?? true,
    ...(imageDataUrl !== undefined ? { imageDataUrl } : {}),
  };

  const row = input.id
    ? await db.celebration.update({ where: { id: input.id }, data, select: { id: true } })
    : await db.celebration.create({ data: { ...data, createdById: user.id }, select: { id: true } });

  await recordAudit({
    userId: user.id,
    action: input.id ? "UPDATE" : "CREATE",
    entityType: "Celebration",
    entityId: row.id,
    entityLabel: title,
  });
  revalidatePath("/people/celebrations");
  return { ok: true, data: row };
}

export async function setCelebrationActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can change a celebration." };
  const row = await db.celebration.update({ where: { id }, data: { active }, select: { title: true } });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Celebration",
    entityId: id,
    entityLabel: `${row.title} — ${active ? "shown" : "hidden"}`,
  });
  revalidatePath("/people/celebrations");
  return { ok: true, data: null };
}

export async function deleteCelebration(id: string): Promise<ActionResult<null>> {
  const { user, allowed } = await requireHr();
  if (!allowed) return { ok: false, error: "Only HR can remove a celebration." };
  const row = await db.celebration.findUnique({ where: { id }, select: { title: true } });
  if (!row) return { ok: false, error: "That celebration no longer exists." };

  await db.celebration.delete({ where: { id } });
  // The dismissal rows go too, so a key can never be reused against a stale record.
  await db.celebrationSeen.deleteMany({ where: { occasionKey: `celebration:${id}` } });

  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Celebration",
    entityId: id,
    entityLabel: row.title,
  });
  revalidatePath("/people/celebrations");
  return { ok: true, data: null };
}

/** Whose birthday and anniversary is coming up — the page HR plans from. */
export async function upcomingOccasions(days = 30) {
  const { allowed } = await requireHr();
  if (!allowed) return [];

  const today = dateOnly(new Date());
  const people = await db.employeeProfile.findMany({
    where: { exitedOn: null, user: { active: true } },
    select: { userId: true, designation: true, dateOfBirth: true, joinedOn: true, user: { select: { name: true } } },
  });

  const out: { userId: string; name: string; designation: string | null; kind: "BIRTHDAY" | "ANNIVERSARY"; on: string; inDays: number; years?: number }[] = [];
  for (const p of people) {
    for (const [kind, date] of [["BIRTHDAY", p.dateOfBirth] as const, ["ANNIVERSARY", p.joinedOn] as const]) {
      if (!date) continue;
      // The next occurrence: this year's if it is still ahead, otherwise next year's.
      let next = new Date(Date.UTC(today.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      if (next < today) next = new Date(Date.UTC(today.getUTCFullYear() + 1, date.getUTCMonth(), date.getUTCDate()));
      const inDays = Math.round((next.getTime() - today.getTime()) / 86400000);
      if (inDays > days) continue;
      const years = next.getUTCFullYear() - date.getUTCFullYear();
      if (kind === "ANNIVERSARY" && years < 1) continue;
      out.push({
        userId: p.userId,
        name: p.user.name,
        designation: p.designation,
        kind,
        on: next.toISOString().slice(0, 10),
        inDays,
        ...(kind === "ANNIVERSARY" ? { years } : {}),
      });
    }
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}
