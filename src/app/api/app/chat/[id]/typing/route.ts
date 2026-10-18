import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { chatTyping } from "@/actions/chat";

/**
 * "Typing…", to the chat's other members who have it open.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  await chatTyping(params.id ?? "");
  return { data: { ok: true } };
});
