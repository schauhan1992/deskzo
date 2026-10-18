import { appRoute } from "@/lib/app/handler";
import { approvalsFor } from "@/lib/app/daily";

/**
 * Everything waiting for the person's decision that the Deskzo app can decide — leave, attendance corrections,
 * expense claims, Automate approval steps, orders and devices (owner, 18 Oct 2026; src/lib/app/daily.ts).
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor }) => ({ data: await approvalsFor(actor.userId) }));
