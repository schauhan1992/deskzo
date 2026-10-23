import { appRoute } from "@/lib/app/handler";
import { appVisitOptions } from "@/lib/app/field";

/** What a new visit offers: its purposes, and a company's people and open leads (`?company=`). */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appVisitOptions);
