import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { cancelLeave } from "@/actions/leave";

/** Cancelling one's own leave from the Deskzo app — the web's own cancelLeave and its rules (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

export const DELETE = appRoute({}, async ({ actor, params }) => {
  await needAppModule("hr", actor.userId);
  const result = await cancelLeave(params.id ?? "");
  if (!result.ok) refused(result);
  return { data: { cancelled: true } };
});
