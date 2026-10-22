import { appRoute } from "@/lib/app/handler";
import { appSearch } from "@/lib/app/sales";

/** GET `?q=`: leads, customers and contacts at once, each where the web's search offers it to the person. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appSearch);
