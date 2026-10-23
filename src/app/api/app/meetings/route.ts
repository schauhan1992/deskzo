import { appRoute } from "@/lib/app/handler";
import { appMeetings, appScheduleMeeting } from "@/lib/app/field";

/** The person's calendar in the Deskzo app. GET `?from=&to=`. POST: a meeting scheduled from a lead, company or visit. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appMeetings);
export const POST = appRoute({}, appScheduleMeeting);
