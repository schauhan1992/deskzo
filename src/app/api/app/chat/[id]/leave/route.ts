import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { leaveGroupChat } from "@/actions/chat";

/**
 * Leaving a group: its messages so far stay readable, nothing new arrives.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  const result = await leaveGroupChat(params.id ?? "");
  if (!result.ok) refused(result);
  return { data: { left: true } };
});
