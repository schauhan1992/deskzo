import { appRoute } from "@/lib/app/handler";
import { throughApp } from "@/lib/app/sales";
import { noteLeadApi } from "@/lib/api/v1/leads";

/** POST `{ type: CALL|MEETING|EMAIL|NOTE, notes }`: something that happened on a lead, logged. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, throughApp("leads", noteLeadApi));
