import { apiRoute } from "@/lib/api/handler";
import { moveLeadApi } from "@/lib/api/v1/leads";

/** A lead moved to another stage — its stage rules apply (src/lib/api/v1/leads.ts). */

export const dynamic = "force-dynamic";

export const POST = apiRoute({ scope: "leads:write" }, moveLeadApi);
