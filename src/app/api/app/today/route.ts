import { appRoute } from "@/lib/app/handler";
import { todayFor } from "@/lib/app/daily";

/**
 * The Deskzo app's Today screen (owner, 18 Oct 2026): clocked in or not, tasks due today and overdue, how much waits
 * for a decision, and leave left — each part only where its module is the person's (src/lib/app/daily.ts).
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor }) => ({ data: await todayFor(actor.userId) }));
