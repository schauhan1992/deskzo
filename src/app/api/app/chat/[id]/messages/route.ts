import { appRoute } from "@/lib/app/handler";
import { needAppModule, refused } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";
import { sendChatMessage } from "@/actions/chat";

/**
 * Sending: a form with `body`, optionally `replyToId` and up to five `files` (5 MB together) — the web's own
 * sendChatMessage, so the word filter, the file types and the mentions are its.
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({}, async ({ actor, req, params }) => {
  await needAppModule("chat", actor.userId);
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new ApiError(400, "invalid_request", "Send the message as a form.");
  }
  form.set("chatId", params.id ?? "");
  const result = await sendChatMessage(form);
  if (!result.ok) refused(result);
  return { status: 201, data: result.data };
});
