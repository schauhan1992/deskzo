import { appRoute } from "@/lib/app/handler";
import { appCompanies, throughApp } from "@/lib/app/sales";
import { createCompanyApi } from "@/lib/api/v1/companies";

/**
 * Companies in the Deskzo app (owner, 22 Oct 2026) — prospects and customers, as the web's Companies list.
 * GET `?view=mine|all&stage=PROSPECT|LEAD|CUSTOMER&search=&page=`. POST: a new company — the
 * public API's own (src/lib/api/v1/companies.ts), with its duplicate-name rule.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appCompanies);
export const POST = appRoute({}, throughApp("companies", createCompanyApi));
