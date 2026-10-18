import { apiRoute } from "@/lib/api/handler";
import { listInvoicesApi } from "@/lib/api/v1/sales";

/** Tax invoices the key's person reaches, listed — read only (src/lib/api/v1/sales.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "invoices:read" }, listInvoicesApi);
