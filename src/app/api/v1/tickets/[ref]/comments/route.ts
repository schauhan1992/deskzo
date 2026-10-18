import { apiRoute } from "@/lib/api/handler";
import { commentTicketApi } from "@/lib/api/v1/work";

/** A comment added to a ticket (src/lib/api/v1/work.ts). */

export const dynamic = "force-dynamic";

export const POST = apiRoute({ scope: "tickets:write" }, commentTicketApi);
