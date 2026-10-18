import { apiRoute } from "@/lib/api/handler";
import { getLeadApi, patchLeadApi } from "@/lib/api/v1/leads";

/** One lead, by its ref (LEAD-000123) or id: read, or change its details (src/lib/api/v1/leads.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "leads:read" }, getLeadApi);
export const PATCH = apiRoute({ scope: "leads:write" }, patchLeadApi);
