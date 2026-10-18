import { appRoute } from "@/lib/app/handler";
import { lookupNumber } from "@/lib/app/calls";

/**
 * Caller ID for the Deskzo app (owner, 18 Oct 2026): `?number=` — who it is as this person may see them,
 * with the company's open leads, the last call and a callback owed; `{ data: null }` for nobody they can see.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async ({ url }) => ({ data: await lookupNumber((url.searchParams.get("number") ?? "").slice(0, 40)) }));
