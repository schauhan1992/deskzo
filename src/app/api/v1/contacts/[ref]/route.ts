import { apiRoute } from "@/lib/api/handler";
import { getContactApi, patchContactApi } from "@/lib/api/v1/companies";

/** One contact, by its ref (CON-000123) or id: read, or changed (src/lib/api/v1/companies.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "contacts:read" }, getContactApi);
export const PATCH = apiRoute({ scope: "contacts:write" }, patchContactApi);
