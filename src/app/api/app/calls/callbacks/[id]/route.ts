import { completeFollowUp } from "@/actions/call";
import { ApiError } from "@/lib/api/handler";
import { appRoute } from "@/lib/app/handler";

/**
 * A callback returned, from the Deskzo app (owner, 18 Oct 2026): the same as ticking it off under Calls or
 * Tasks — the Calls module's own action, as the phone's person.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({ calls: true }, async ({ params }) => {
  const done = await completeFollowUp(params.id ?? "");
  if (!done.ok) throw new ApiError(404, "not_found", done.error);
  return { data: { done: true } };
});
