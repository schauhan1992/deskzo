import { apiRoute } from "@/lib/api/handler";
import { getOrderApi } from "@/lib/api/v1/sales";

/** One order, by its ref (ORD-000123) or id — read only (src/lib/api/v1/sales.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "orders:read" }, getOrderApi);
