import { appRoute } from "@/lib/app/handler";
import { appExpenseOptions } from "@/lib/app/field";

/** What a claim offers: categories, how it was paid, and over what amount a receipt is needed. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appExpenseOptions);
