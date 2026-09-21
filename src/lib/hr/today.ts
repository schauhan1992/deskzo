import { cache } from "react";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { dateOnly } from "@/lib/hr/calendar";
import { greeting, momentsFor, type Moment } from "@/lib/hr/celebrations";

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
export const todaysMoments = cache(async (): Promise<{ greeting: string; moments: Moment[] }> => {
  const user = await currentUser();
  const now = new Date();
  const firstName = user?.name.split(" ")[0] ?? "there";
  const empty = { greeting: greeting(now, firstName), moments: [] as Moment[] };
  if (!user) return empty;

  try {
    const hr = await db.systemModule.findUnique({ where: { key: "hr" }, select: { enabled: true } });
    if (hr && !hr.enabled) return empty;

    const today = dateOnly(now);
    const [viewer, people, holidays, celebrations, seen] = await Promise.all([
      db.user.findUnique({ where: { id: user.id }, select: { departmentId: true } }),
      db.employeeProfile.findMany({
        where: { exitedOn: null, user: { active: true } },
        select: {
          userId: true,
          designation: true,
          dateOfBirth: true,
          joinedOn: true,
          user: { select: { name: true, departmentId: true } },
        },
      }),
      db.holiday.findMany({ select: { id: true, name: true, date: true, optional: true } }),
      db.celebration.findMany({
        where: { active: true, startsOn: { lte: today }, endsOn: { gte: today } },
        orderBy: { createdAt: "desc" },
        include: { subject: { select: { id: true, name: true } } },
      }),
      db.celebrationSeen.findMany({ where: { userId: user.id }, select: { occasionKey: true } }),
    ]);

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
