import { appRoute } from "@/lib/app/handler";
import { appVisit } from "@/lib/app/field";

/** One visit, by its id or ref (VIS-000123): who, where, its check-in and check-out places, its claims. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appVisit);
