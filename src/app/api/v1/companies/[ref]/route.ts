import { apiRoute } from "@/lib/api/handler";
import { getCompanyApi, patchCompanyApi } from "@/lib/api/v1/companies";

/** One company, by its ref (COM-000123) or id: read, or changed (src/lib/api/v1/companies.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "companies:read" }, getCompanyApi);
export const PATCH = apiRoute({ scope: "companies:write" }, patchCompanyApi);
