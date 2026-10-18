import { apiRoute } from "@/lib/api/handler";
import { listTicketsApi, createTicketApi } from "@/lib/api/v1/work";

/** Tickets the key's person reaches: listed, and opened (src/lib/api/v1/work.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "tickets:read" }, listTicketsApi);
export const POST = apiRoute({ scope: "tickets:write" }, createTicketApi);
