import { appRoute } from "@/lib/app/handler";
import { appPlanVisit, appVisits } from "@/lib/app/field";

/** The person's visits in the Deskzo app (owner, 22 Oct 2026). GET `?view=today|upcoming|past`. POST: a visit planned. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appVisits);
export const POST = appRoute({}, appPlanVisit);
