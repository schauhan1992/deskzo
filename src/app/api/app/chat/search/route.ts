import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { searchChatMessages } from "@/actions/chat";

/**
 * Messages with `?q=` in them, from the chats the person is in — only what they could scroll back to.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, url }) => {
  await needAppModule("chat", actor.userId);
  return { data: await searchChatMessages(url.searchParams.get("q") ?? "") };
});
