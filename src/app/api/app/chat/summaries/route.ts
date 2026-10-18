import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { listChatSummaries } from "@/actions/chat";

/**
 * Rows of the chat list again: all of them, or `?ids=a,b` — after the live stream says a chat changed.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, url }) => {
  await needAppModule("chat", actor.userId);
  const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
  return { data: await listChatSummaries(ids.length ? ids : undefined) };
});
