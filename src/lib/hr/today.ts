import { cache } from "react";
import { db } from "@/lib/db";
import { currentUser, viewAsContext } from "@/lib/session";
import { wishedBy } from "@/lib/hr/wishes";
import { workspaceClock } from "@/lib/time/workspace";
import { indiaClock } from "@/lib/time/zone";
import { greeting, momentsFor, type Moment } from "@/lib/hr/celebrations";
import { detectSalesWinsLazily, withoutOrphanedWins } from "@/lib/wins/detect";
import { announceActivityAwardsLazily } from "@/lib/performance/announce";
import { announcePrizesLazily } from "@/lib/wins/prize-announce";
import { moduleAvailableForTenant } from "@/lib/modules-access";

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
  // Never throws, as the rest of this: India's clock if the workspace can't be asked.
  const clock = await workspaceClock().catch(() => indiaClock);
  const empty = { greeting: greeting(now, firstName, clock), moments: [] as Moment[] };
  if (!user) return empty;

  try {
    const [hrOn, winsOn] = await Promise.all([moduleAvailableForTenant("hr"), moduleAvailableForTenant("wins")]);
    // Sales wins celebrate themselves even where nobody has set up the scheduler, and the fortnight's
    // most active and the prizes up for grabs are announced the same way. All throttled inside.
    if (winsOn) {
      await detectSalesWinsLazily(now);
      await announceActivityAwardsLazily(now);
      await announcePrizesLazily(now);
    }

    // The workspace's today, as a @db.Date holds a day — UTC's was yesterday's until 05:30 in India.
    const today = clock.calendarDate(now);
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

    const moments = momentsFor({
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
    });
    return { greeting: greeting(now, firstName, clock), moments: await withWishes(moments, user.id) };
  } catch {
    return empty;
  }
});

/**
 * A colleague's birthday or anniversary becomes something to wish them on, marked sent where the
 * viewer already has. Not while viewing as somebody. A lookup that fails (a workspace not yet given
 * the wishes table, mid-release) leaves the strip as it was rather than taking the greeting with it.
 */
async function withWishes(moments: Moment[], viewerId: string): Promise<Moment[]> {
  const wishable = moments.filter((m) => (m.tone === "birthday" || m.tone === "anniversary") && m.subject && !m.aboutViewer);
  if (wishable.length === 0 || (await viewAsContext())) return moments;
  try {
    const sent = await wishedBy(viewerId, wishable.map((m) => m.key));
    return moments.map((m) =>
      wishable.includes(m)
        ? { ...m, wish: { kind: m.tone === "birthday" ? "BIRTHDAY" : "ANNIVERSARY", firstName: m.subject!.name.split(" ")[0]!, sent: sent.has(m.key) } }
        : m,
    );
  } catch {
    return moments;
  }
}
