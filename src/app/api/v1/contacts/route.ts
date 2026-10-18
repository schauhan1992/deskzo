import { apiRoute } from "@/lib/api/handler";
import { listContactsApi, createContactApi } from "@/lib/api/v1/companies";

/** Contacts the key's person reaches: listed, and added to a company (src/lib/api/v1/companies.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "contacts:read" }, listContactsApi);
export const POST = apiRoute({ scope: "contacts:write" }, createContactApi);
