import { appRoute } from "@/lib/app/handler";
import { appCreateExpense, appExpenses } from "@/lib/app/field";

/** The person's expense claims in the Deskzo app. GET `?status=`. POST a form with the receipt photo: a claim. */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, appExpenses);
export const POST = appRoute({}, appCreateExpense);
