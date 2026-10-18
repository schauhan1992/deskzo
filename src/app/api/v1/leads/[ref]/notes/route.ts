import { apiRoute } from "@/lib/api/handler";
import { noteLeadApi } from "@/lib/api/v1/leads";

/** A note, call, email or meeting logged on a lead (src/lib/api/v1/leads.ts). */

export const dynamic = "force-dynamic";

export const POST = apiRoute({ scope: "leads:write" }, noteLeadApi);
