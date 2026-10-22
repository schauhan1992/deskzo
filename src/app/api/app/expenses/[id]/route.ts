import { appRoute } from "@/lib/app/handler";
import { appDeleteExpense, appExpense } from "@/lib/app/field";

/** One claim: read, or taken back while it isn't decided (DELETE). */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appExpense);
export const DELETE = appRoute({}, appDeleteExpense);
