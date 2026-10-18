import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { createGroupChat } from "@/actions/chat";

/**
 * A new group, `{ name, member_ids }`, with the person as its admin.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const memberIds = Array.isArray(input.member_ids) ? input.member_ids.map(String) : [];
  const result = await createGroupChat({ name: String(input.name ?? ""), memberIds });
  if (!result.ok) refused(result);
  return { status: 201, data: { chat_id: result.data.chatId } };
});
