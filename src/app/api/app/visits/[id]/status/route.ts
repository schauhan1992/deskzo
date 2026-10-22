import { appRoute } from "@/lib/app/handler";
import { appVisitStatus } from "@/lib/app/field";

/** POST `{ status: CANCELLED|NO_SHOW, note }`: a visit that didn't happen, and why. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, appVisitStatus);
