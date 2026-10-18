import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { pinChatMessage } from "@/actions/chat";

/**
 * Pin a message to the top of its chat (three at most), or `{ pinned: false }` to take it down.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const result = await pinChatMessage(params.id ?? "", input.pinned !== false);
  if (!result.ok) refused(result);
  return { data: result.data };
});
