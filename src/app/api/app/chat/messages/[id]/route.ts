import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { deleteChatMessage, editChatMessage } from "@/actions/chat";

/**
 * One's own message: PATCH `{ body }` edits it (within fifteen minutes), DELETE deletes it for everyone (within the
 * hour) — the web's own rules.
 */

export const dynamic = "force-dynamic";

export const PATCH = appRoute({}, async ({ actor, params, body }) => {
  await needAppModule("chat", actor.userId);
  const input = await body();
  const result = await editChatMessage(params.id ?? "", String(input.body ?? ""));
  if (!result.ok) refused(result);
  return { data: result.data };
});

export const DELETE = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  const result = await deleteChatMessage(params.id ?? "");
  if (!result.ok) refused(result);
  return { data: result.data };
});
