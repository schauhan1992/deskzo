import { apiRoute } from "@/lib/api/handler";
import { getTicketApi, patchTicketApi } from "@/lib/api/v1/work";

/** One ticket, by its ref (TCK-000123) or id: read, or changed — status, priority, assignee (src/lib/api/v1/work.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "tickets:read" }, getTicketApi);
export const PATCH = apiRoute({ scope: "tickets:write" }, patchTicketApi);
