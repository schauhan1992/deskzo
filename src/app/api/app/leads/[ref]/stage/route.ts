import { appRoute } from "@/lib/app/handler";
import { throughApp } from "@/lib/app/sales";
import { moveLeadApi } from "@/lib/api/v1/leads";

/** POST `{ stage }` or `{ status, lost_reason? }`: a lead moved along, by the stage rules the web keeps. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, throughApp("leads", moveLeadApi));
