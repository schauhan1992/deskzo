import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { startDirectChat } from "@/actions/chat";

/**
 * A chat with one colleague, `{ user_id }` — theirs and the person's, the same one however often it is opened.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const result = await startDirectChat(String(input.user_id ?? ""));
  if (!result.ok) refused(result);
  return { data: { chat_id: result.data.chatId } };
});
