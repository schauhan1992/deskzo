import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { chatPins } from "@/actions/chat";

/**
 * The messages pinned to the top of a chat — after the live stream says they changed.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  return { data: await chatPins(params.id ?? "") };
});
