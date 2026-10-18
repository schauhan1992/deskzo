import { appRoute } from "@/lib/app/handler";
import { callsToReview } from "@/lib/app/calls";

/** The person's calls from their phones still waiting to be told how they went (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async () => ({ data: await callsToReview() }));
