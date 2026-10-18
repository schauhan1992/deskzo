import { apiRoute } from "@/lib/api/handler";
import { listOrdersApi } from "@/lib/api/v1/sales";

/** Orders the key's person reaches, listed — read only (src/lib/api/v1/sales.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "orders:read" }, listOrdersApi);
