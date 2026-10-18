import { apiRoute } from "@/lib/api/handler";
import { listCompaniesApi, createCompanyApi } from "@/lib/api/v1/companies";

/** Companies the key's person reaches: listed, and added (src/lib/api/v1/companies.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "companies:read" }, listCompaniesApi);
export const POST = apiRoute({ scope: "companies:write" }, createCompanyApi);
