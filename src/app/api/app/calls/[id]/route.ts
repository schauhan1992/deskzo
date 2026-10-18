import { appRoute } from "@/lib/app/handler";
import { reviewPhoneCall } from "@/lib/app/calls";

/**
 * The after-call card (owner, 18 Oct 2026): `{ outcome, notes?, follow_up_at?, lead_id? }` for one of the
 * person's own calls from a phone.
 */

export const dynamic = "force-dynamic";

export const PATCH = appRoute({ calls: true }, async ({ params, body }) => ({ data: await reviewPhoneCall(params.id ?? "", await body()) }));
