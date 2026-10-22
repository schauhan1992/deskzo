import { appRoute } from "@/lib/app/handler";
import { appSubmitExpense } from "@/lib/app/field";

/** POST: a saved claim, submitted for approval — with its receipt where the company asks for one. */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, appSubmitExpense);
