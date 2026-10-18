import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { muteChat } from "@/actions/chat";

/**
 * Mute a chat for `{ hours }`, or `{ hours: null }` to hear it again.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const hours = typeof input.hours === "number" ? input.hours : null;
  const result = await muteChat(params.id ?? "", hours);
  if (!result.ok) refused(result);
  return { data: { muted: hours !== null } };
});
