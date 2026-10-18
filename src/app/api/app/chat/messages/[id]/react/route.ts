import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { reactToChatMessage } from "@/actions/chat";

/**
 * A reaction — one of the six — or `{ emoji: null }` to take one's own away.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const result = await reactToChatMessage(params.id ?? "", typeof input.emoji === "string" ? input.emoji : null);
  if (!result.ok) refused(result);
  return { data: result.data };
});
