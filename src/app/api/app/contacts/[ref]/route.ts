import { appRoute } from "@/lib/app/handler";
import { throughApp } from "@/lib/app/sales";
import { getContactApi, patchContactApi } from "@/lib/api/v1/companies";

/** One contact in the Deskzo app, by its ref (CON-000123) or id: read, or changed. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, throughApp("companies", getContactApi));
export const PATCH = appRoute({}, throughApp("companies", patchContactApi));
