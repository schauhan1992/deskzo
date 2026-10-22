import { appRoute } from "@/lib/app/handler";
import { appLead, throughApp } from "@/lib/app/sales";
import { patchLeadApi } from "@/lib/api/v1/leads";

/** One lead in the Deskzo app, by its ref (LEAD-000123) or id: with its history and stages, or changed. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appLead);
export const PATCH = appRoute({}, throughApp("leads", patchLeadApi));
