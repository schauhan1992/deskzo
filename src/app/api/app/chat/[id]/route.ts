import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";
import { openChat } from "@/actions/chat";

/**
 * One conversation: its newest page of messages (or the page `?around=` a message), its members with their ticks, and
 * its pins. A chat the person was never in is not found.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, params, url }) => {
  await needAppModule("chat", actor.userId);
  const opened = await openChat(params.id ?? "", url.searchParams.get("around") ?? undefined);
  if (!opened) throw new ApiError(404, "not_found", "That chat isn't one of yours.");
  return { data: opened };
});
