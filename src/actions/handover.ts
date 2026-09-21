"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { HANDOVER_AREAS, areaByKey, type HandoverContext } from "@/lib/handover/areas";
import { routingProblem, splitFor, accountsForEverything, type Routing, type Successor } from "@/lib/handover/plan";
import type { ActionResult } from "@/actions/company";

/**
 * Moving one person's live work to colleagues.
 *
 * For a resignation, a long absence, or a change of territory — deliberately not welded to the exit
 * flow, because the same job comes up when nobody is leaving.
 *
 * ## What this will not do
 *
 * It reassigns live ownership and nothing else. It cannot touch who created, approved, verified or
 * was paid for anything, and it cannot touch anybody's own HR records, because the only writes it
 * can perform are the ones declared in `HANDOVER_AREAS` — see the reasoning there. There is no
 * escape hatch and no "everything" option, by design.
 *
 * ## Preview and apply read the same rows
 *
 * Both call `area.hold()`. A preview computed a different way is a preview that can lie, and the
 * lie only surfaces afterwards when the counts disagree and nobody knows which records were missed.
 */

async function mayHandOver(userId: string) {
  return hasEffectivePermission(userId, "people.handover");
}

/** Everybody a handover can route to. Inactive accounts are included so the reason is explainable. */
async function candidates(): Promise<Successor[]> {
  return db.user.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, active: true } });
}

export type AreaInventory = {
  key: string;
  label: string;
  detail: string;
  splittable: boolean;
  count: number;
};

/**
 * What this person is holding right now.
 *
 * Every area is returned, including the empty ones. A screen that hides what is at zero cannot be
 * read as "this is everything they have" — the reader cannot tell the difference between an area
 * with nothing in it and an area the system forgot to look at.
 */
export async function handoverInventory(
  userId: string,
): Promise<ActionResult<{ areas: AreaInventory[]; people: Successor[]; total: number }>> {
  const actor = await requireUser();
  if (!(await mayHandOver(actor.id))) return { ok: false, error: "You can't hand over someone's work." };

  const person = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!person) return { ok: false, error: "That user no longer exists." };

  const [counts, people] = await Promise.all([
    Promise.all(HANDOVER_AREAS.map((area) => area.hold(db, userId).then((rows) => rows.length))),
    candidates(),
  ]);

  const areas = HANDOVER_AREAS.map((area, i) => ({
    key: area.key,
    label: area.label,
    detail: area.detail,
    splittable: area.splittable,
    count: counts[i]!,
  }));

  return { ok: true, data: { areas, people, total: counts.reduce((a, b) => a + b, 0) } };
}

export type HandoverEntry = {
  id: string;
  at: Date;
  /** "given" — their work went out. "received" — somebody else's came in. */
  direction: "given" | "received";
  /** The other person: whose work it was, or nobody in particular when they were the source. */
  counterpartName: string;
  performedByName: string;
  reason: string | null;
  lines: { areaLabel: string; personName: string; count: number }[];
  total: number;
};

/**
 * Every handover this person was part of, both directions, newest first.
 *
 * Both directions because a handover is equally a fact about the person who received it — "where
 * did these forty accounts come from" is asked far more often than "where did his go", and only
 * one of those two questions has ever been answerable.
 */
export async function handoverHistory(userId: string): Promise<HandoverEntry[]> {
  await requireUser();

  const [given, received] = await Promise.all([
    db.handover.findMany({
      where: { fromUserId: userId },
      orderBy: { createdAt: "desc" },
      include: {
        performedBy: { select: { name: true } },
        lines: { include: { toUser: { select: { name: true } } } },
      },
    }),
    // Every handover that sent this person something, including ones where they were one of
    // several recipients — the lines are filtered to theirs so a shared split does not read as if
    // they took the lot.
    db.handover.findMany({
      where: { lines: { some: { toUserId: userId } } },
      orderBy: { createdAt: "desc" },
      include: {
        fromUser: { select: { name: true } },
        performedBy: { select: { name: true } },
        lines: { where: { toUserId: userId }, include: { toUser: { select: { name: true } } } },
      },
    }),
  ]);

  const entries: HandoverEntry[] = [
    ...given.map((h) => ({
      id: h.id,
      at: h.createdAt,
      direction: "given" as const,
      counterpartName: "",
      performedByName: h.performedBy.name,
      reason: h.reason,
      lines: h.lines.map((l) => ({ areaLabel: l.areaLabel, personName: l.toUser.name, count: l.count })),
      total: h.lines.reduce((sum, l) => sum + l.count, 0),
    })),
    ...received.map((h) => ({
      id: h.id,
      at: h.createdAt,
      direction: "received" as const,
      counterpartName: h.fromUser.name,
      performedByName: h.performedBy.name,
      reason: h.reason,
      lines: h.lines.map((l) => ({ areaLabel: l.areaLabel, personName: l.toUser.name, count: l.count })),
      total: h.lines.reduce((sum, l) => sum + l.count, 0),
    })),
  ];

  // Somebody can hand their work out and receive somebody else's on the same day, so the two
  // lists are merged rather than shown as separate sections in arbitrary order.
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export type HandoverPlanInput = {
  fromUserId: string;
  routings: { key: string; routing: Routing }[];
  /** Why, in whoever-ran-it's own words. Read back on both people's records months later. */
  reason?: string;
};

export type HandoverOutcome = {
  areaKey: string;
  label: string;
  moves: { userId: string; name: string; count: number }[];
};

/**
 * Do it.
 *
 * One transaction across every area. A handover that half-applies is worse than one that fails:
 * the accounts move, the tickets do not, and the person running it has no way to tell which half
 * they are looking at.
 */
export async function applyHandover(
  input: HandoverPlanInput,
): Promise<ActionResult<{ outcomes: HandoverOutcome[]; total: number }>> {
  const actor = await requireUser();
  if (!(await mayHandOver(actor.id))) return { ok: false, error: "You can't hand over someone's work." };

  const from = await db.user.findUnique({ where: { id: input.fromUserId }, select: { id: true, name: true } });
  if (!from) return { ok: false, error: "That user no longer exists." };

  const people = await candidates();
  const nameOf = new Map(people.map((p) => [p.id, p.name]));

  // Validate everything before writing anything, so a bad row on the eighth area does not leave
  // the first seven applied.
  const prepared: { area: (typeof HANDOVER_AREAS)[number]; routing: Routing }[] = [];
  for (const { key, routing } of input.routings) {
    const area = areaByKey.get(key);
    if (!area) return { ok: false, error: `Unknown area: ${key}` };
    if (routing.mode === "KEEP") continue;
    const problem = routingProblem(area, routing, { fromUserId: from.id, people });
    if (problem) return { ok: false, error: `${area.label}: ${problem}` };
    prepared.push({ area, routing });
  }
  if (prepared.length === 0) return { ok: false, error: "Nothing was chosen to move." };

  const ctx: HandoverContext = { actorId: actor.id, fromUserId: from.id };
  const outcomes: HandoverOutcome[] = [];

  await db.$transaction(async (tx) => {
    for (const { area, routing } of prepared) {
      // Re-read inside the transaction rather than trusting the preview: something may have been
      // reassigned, closed or created in the minutes somebody spent on the screen.
      const records = await area.hold(tx, from.id);
      if (records.length === 0) continue;

      const split = splitFor(records, routing);
      if (!accountsForEverything(records, split)) {
        // Cannot happen with the allocator as written, which is exactly why it is asserted: a
        // record silently dropped here stays assigned to somebody who has left.
        throw new Error(`Handover split lost records in ${area.key}`);
      }

      for (const { userId, ids } of split) await area.give(tx, ids, userId, ctx);

      outcomes.push({
        areaKey: area.key,
        label: area.label,
        moves: split.map((s) => ({ userId: s.userId, name: nameOf.get(s.userId) ?? "Unknown", count: s.ids.length })),
      });
    }

    // Written here rather than after the loop, so the record and the reassignment it describes
    // stand or fall together. A handover with no record of it, and a record of one that did not
    // happen, are both worse than neither.
    if (outcomes.length > 0) {
      await tx.handover.create({
        data: {
          fromUserId: from.id,
          performedById: actor.id,
          reason: input.reason?.trim() || null,
          lines: {
            create: outcomes.flatMap((outcome) =>
              outcome.moves.map((move) => ({
                areaKey: outcome.areaKey,
                // Frozen: renaming an area later must not rewrite what March's handover says.
                areaLabel: outcome.label,
                toUserId: move.userId,
                count: move.count,
              })),
            ),
          },
        },
      });
    }
  });

  const total = outcomes.reduce((sum, o) => sum + o.moves.reduce((s, m) => s + m.count, 0), 0);
  if (total === 0) return { ok: false, error: `${from.name} had nothing left to move.` };

  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "User",
    entityId: from.id,
    entityLabel: `Handover from ${from.name} — ${outcomes
      .map((o) => `${o.label.toLowerCase()} ×${o.moves.reduce((s, m) => s + m.count, 0)}`)
      .join(", ")}`,
  });

  // Told, not left to be discovered. Work appearing in somebody's queue overnight with no
  // explanation is how a handover turns into a fortnight of nothing happening.
  const perPerson = new Map<string, number>();
  for (const outcome of outcomes) {
    for (const move of outcome.moves) perPerson.set(move.userId, (perPerson.get(move.userId) ?? 0) + move.count);
  }
  await Promise.all(
    [...perPerson].map(([userId, count]) =>
      notifyUser({
        userId,
        type: "TASK_ASSIGNED",
        title: `${count} item${count === 1 ? "" : "s"} moved to you from ${from.name}`,
        message: outcomes
          .filter((o) => o.moves.some((m) => m.userId === userId))
          .map((o) => `${o.label}: ${o.moves.find((m) => m.userId === userId)!.count}`)
          .join(" · "),
        link: "/dashboard",
      }),
    ),
  );

  revalidatePath("/", "layout");
  return { ok: true, data: { outcomes, total } };
}
