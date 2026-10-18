import { apiRoute } from "@/lib/api/handler";
import { getInvoiceApi } from "@/lib/api/v1/sales";

/** One tax invoice, by its id, with its lines — read only (src/lib/api/v1/sales.ts). */

export const dynamic = "force-dynamic";

export const GET = apiRoute({ scope: "invoices:read" }, getInvoiceApi);
