import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { markChatRead } from "@/actions/chat";

/**
 * Read up to now — the blue ticks for whoever sent them, and the person's unread count after.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  return { data: await markChatRead(params.id ?? "") };
});
