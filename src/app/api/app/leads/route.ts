import { appRoute } from "@/lib/app/handler";
import { appLeads, throughApp } from "@/lib/app/sales";
import { createLeadApi } from "@/lib/api/v1/leads";

/**
 * Leads in the Deskzo app (owner, 22 Oct 2026). GET `?view=mine|all&search=&status=&stage=&pipeline=&page=`.
 * POST: a new lead — the public API's own (src/lib/api/v1/leads.ts), as the phone's person.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appLeads);
export const POST = appRoute({}, throughApp("leads", createLeadApi));
