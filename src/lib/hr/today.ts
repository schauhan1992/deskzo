import { cache } from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { dateOnly } from "@/lib/hr/calendar";
import { greeting, momentsFor, type Moment } from "@/lib/hr/celebrations";
import { detectSalesWinsLazily, withoutOrphanedWins } from "@/lib/wins/detect";
import { announceActivityAwardsLazily } from "@/lib/performance/announce";
import { announcePrizesLazily } from "@/lib/wins/prize-announce";

/**
 * What to greet the signed-in person with today.
 *
 * Wrapped in React's `cache` because both the dashboard layout (which shows the splash) and the
 * dashboard page (which shows the strip) need it on the same render — without this they would each
 * run the same five queries.
 *
 * Written to never throw. It is read on every dashboard render, and a birthday is not worth taking
 * the app down for: an HR module that is switched off, or a database missing the tables, returns
 * the greeting alone.
 */
const MANUAL = ["MANUAL"] as const;
const SALES_WINS = ["DEAL_WON", "TARGET_HIT", "FIRST_ORDER", "TOP_PERFORMER", "MOST_ACTIVE", "PRIZES"] as const;

export const todaysMoments = cache(async (): Promise<{ greeting: string; moments: Moment[] }> => {
  const user = await currentUser();
  const now = new Date();
  const firstName = user?.name.split(" ")[0] ?? "there";
  const empty = { greeting: greeting(now, firstName), moments: [] as Moment[] };
  if (!user) return empty;

  try {
    const [hr, wins] = await Promise.all([
      db.systemModule.findUnique({ where: { key: "hr" }, select: { enabled: true } }),
      db.systemModule.findUnique({ where: { key: "wins" }, select: { enabled: true } }),
    ]);
    const hrOn = !hr || hr.enabled;
    const winsOn = !wins || wins.enabled;
    // Sales wins celebrate themselves even where nobody has set up the scheduler, and the fortnight's
    // most active and the prizes up for grabs are announced the same way. All throttled inside.
    if (winsOn) {
      await detectSalesWinsLazily(now);
      await announceActivityAwardsLazily(now);
      await announcePrizesLazily(now);
    }

    const today = dateOnly(now);
    const [viewer, people, holidays, allCelebrations, seen] = await Promise.all([
      db.user.findUnique({ where: { id: user.id }, select: { departmentId: true } }),
      !hrOn ? Promise.resolve([]) : db.employeeProfile.findMany({
        where: { exitedOn: null, user: { active: true } },
        select: {
          userId: true,
          designation: true,
          dateOfBirth: true,
          joinedOn: true,
          user: { select: { name: true, departmentId: true } },
        },
      }),
      !hrOn ? Promise.resolve([]) : db.holiday.findMany({ select: { id: true, name: true, date: true, optional: true } }),
      db.celebration.findMany({
        where: {
          active: true,
          startsOn: { lte: today },
          endsOn: { gte: today },
          // HR's greetings while HR is on; the sales wins, the most active and the prizes while the
          // wins module is.
          source: { in: [...(hrOn ? MANUAL : []), ...(winsOn ? SALES_WINS : [])] },
        },
        orderBy: { createdAt: "desc" },
        include: { subject: { select: { id: true, name: true } } },
      }),
      db.celebrationSeen.findMany({ where: { userId: user.id }, select: { occasionKey: true } }),
    ]);
    // A win for a customer, deal or target deleted since is not celebrated — see withoutOrphanedWins.
    const celebrations = await withoutOrphanedWins(allCelebrations);

    return {
      greeting: greeting(now, firstName),
      moments: momentsFor({
        today,
        viewer: { userId: user.id, departmentId: viewer?.departmentId ?? null },
        people: people.map((p) => ({
          userId: p.userId,
          name: p.user.name,
          designation: p.designation,
          dateOfBirth: p.dateOfBirth,
          joinedOn: p.joinedOn,
          departmentId: p.user.departmentId,
        })),
        holidays,
        celebrations,
        seen: seen.map((s) => s.occasionKey),
      }),
    };
  } catch {
    return empty;
  }
});
