"use server";

import { revalidatePath } from "next/cache";
import type { InternalFeedbackKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { toPlain } from "@/lib/serialize";
import { DAILY_FEEDBACK_LIMIT, submissionDate } from "@/lib/engagement/anonymity";
import type { ActionResult } from "@/actions/company";

/**
 * The anonymous channel.
 *
 * ## What this file must never do
 *
 * Write the sender's identity anywhere that can be joined to what they wrote. That means:
 *
 *   - no author column on `InternalFeedback` — there isn't one to fill,
 *   - **no `recordAudit` call on submission.** An audit row saying "Priya submitted anonymous
 *     feedback" at 14:32 alongside a feedback row dated today defeats the whole feature, and it is
 *     the mistake that would be easiest to make out of habit, since every other action here audits.
 *   - no notification naming the sender,
 *   - no IP, no user agent, no session id,
 *   - and no timestamp finer than a date.
 *
 * The rate limit is the one thing that needs to know who is submitting. It lives in its own table,
 * holds a count and a date and no content, and is written in a **separate transaction** from the
 * feedback itself so the two cannot even be correlated by transaction id in the write-ahead log.
 *
 * ## What it cannot protect against
 *
 * The text. Somebody describing an argument four people witnessed has identified themselves
 * whatever this stores. The submission form says so, in those words, before they type.
 */

export async function submitAnonymousFeedback(input: {
  kind: InternalFeedbackKind;
  aboutUserId?: string;
  rating?: number;
  body: string;
}): Promise<ActionResult<{ remainingToday: number }>> {
  const user = await requireModuleUser("engagement");
  const body = input.body.trim();
  if (body.length < 10) {
    return { ok: false, error: "Say a little more — ten characters isn't enough for anybody to act on." };
  }
  if (input.rating !== undefined && (input.rating < 1 || input.rating > 5)) {
    return { ok: false, error: "A rating is one to five." };
  }

  const onDate = submissionDate(new Date());

  // ── The roll. Written first and on its own, so a failure here stops the submission rather than
  //    leaving an uncounted one behind. Holds no content.
  const quota = await db.feedbackQuota.upsert({
    where: { user_day: { userId: user.id, onDate } },
    create: { userId: user.id, onDate, count: 0 },
    update: {},
    select: { count: true },
  });
  if (quota.count >= DAILY_FEEDBACK_LIMIT) {
    return { ok: false, error: `That's ${DAILY_FEEDBACK_LIMIT} today, which is the daily limit. It resets tomorrow.` };
  }
  await db.feedbackQuota.update({
    where: { user_day: { userId: user.id, onDate } },
    data: { count: { increment: 1 } },
  });

  // ── The ballot. Nothing here identifies the sender, and nothing above is referenced.
  await db.internalFeedback.create({
    data: {
      kind: input.kind,
      aboutUserId: input.aboutUserId || null,
      rating: input.rating ?? null,
      body,
      submittedOn: onDate,
    },
  });

  // Deliberately no recordAudit. See the note at the top of this file.

  // HR is told that something arrived, and nothing else. The notification names no sender, no
  // subject and carries no text — it is a doorbell, not a copy.
  const readers = await db.user.findMany({
    where: { active: true },
    select: { id: true },
  });
  const allowed = await Promise.all(readers.map((r) => hasEffectivePermission(r.id, "engagement.readFeedback")));
  await Promise.all(
    readers
      .filter((_, i) => allowed[i])
      .map((r) =>
        notifyUser({
          userId: r.id,
          type: "FEEDBACK_SUBMITTED",
          title: "New anonymous feedback",
          message: "Something has come in through the anonymous channel.",
          link: "/people/feedback",
        }),
      ),
  );

  revalidatePath("/people/feedback");
  return { ok: true, data: { remainingToday: DAILY_FEEDBACK_LIMIT - quota.count - 1 } };
}

/** How many more this person may send today. Shown on the form so the limit is not a surprise. */
export async function remainingFeedbackToday(): Promise<number> {
  const user = await requireModuleUser("engagement");
  const row = await db.feedbackQuota.findUnique({
    where: { user_day: { userId: user.id, onDate: submissionDate(new Date()) } },
    select: { count: true },
  });
  return DAILY_FEEDBACK_LIMIT - (row?.count ?? 0);
}

/**
 * Everything that has come in.
 *
 * HR, directors and admins only. The person an item is about does not see it here or anywhere —
 * HR decides what to raise and how, which is the arrangement that keeps a speak-up channel from
 * becoming a way to say something to somebody's face without owning it.
 */
export async function listInternalFeedback(filters?: { kind?: InternalFeedbackKind; aboutUserId?: string; unreviewed?: boolean }) {
  const user = await requireModuleUser("engagement");
  if (!(await hasEffectivePermission(user.id, "engagement.readFeedback"))) return null;

  const rows = await db.internalFeedback.findMany({
    where: {
      ...(filters?.kind ? { kind: filters.kind } : {}),
      ...(filters?.aboutUserId ? { aboutUserId: filters.aboutUserId } : {}),
      ...(filters?.unreviewed ? { reviewedAt: null } : {}),
    },
    // By date, then by id. Not by creation time — there is no creation time, which is the point.
    orderBy: [{ submittedOn: "desc" }, { id: "desc" }],
    select: {
      id: true, kind: true, rating: true, body: true, submittedOn: true,
      reviewedAt: true, reviewNote: true,
      aboutUser: { select: { id: true, name: true } },
      reviewedBy: { select: { name: true } },
    },
  });
  return toPlain(rows);
}

export async function reviewFeedback(id: string, note: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("engagement");
  if (!(await hasEffectivePermission(user.id, "engagement.readFeedback"))) {
    return { ok: false, error: "You can't review internal feedback." };
  }
  await db.internalFeedback.update({
    where: { id },
    data: { reviewedAt: new Date(), reviewedById: user.id, reviewNote: note.trim() || null },
  });
  // Auditing the *review* is fine — it says who read it, not who wrote it.
  revalidatePath("/people/feedback");
  return { ok: true, data: null };
}

/** Colleagues feedback can be written about. Everyone active, including the writer's own manager. */
export async function feedbackSubjects() {
  await requireModuleUser("engagement");
  return toPlain(
    await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  );
}
