import { appRoute } from "@/lib/app/handler";
import { appCompleteVisit } from "@/lib/app/field";

/** POST `{ outcome, distance_km?, latitude?, … }`: the visit written up, and where the phone was on leaving. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, appCompleteVisit);
