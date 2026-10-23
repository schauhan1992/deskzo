import { appRoute } from "@/lib/app/handler";
import { appCompany, throughApp } from "@/lib/app/sales";
import { patchCompanyApi } from "@/lib/api/v1/companies";

/** One company in the Deskzo app, by its ref (COM-000123) or id: with its contacts, open leads and history, or changed. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appCompany);
export const PATCH = appRoute({}, throughApp("companies", patchCompanyApi));
