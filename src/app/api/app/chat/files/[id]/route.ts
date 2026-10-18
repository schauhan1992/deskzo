import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";
import { db } from "@/lib/db";
import { chatSettings, membershipOf } from "@/lib/chat/server";
import { opensInBrowser } from "@/lib/chat/rules";

/**
 * One file sent in a chat, to a member of it and nobody else, as the website's (src/app/api/chat/files/[id]) — for
 * the app to show a picture. Where the workspace keeps chat files view-only, only what can be shown is given.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, params }) => {
  await needAppModule("chat", actor.userId);
  const file = await db.chatAttachment.findUnique({
    where: { id: params.id ?? "" },
    select: { fileName: true, mimeType: true, data: true, message: { select: { chatId: true, createdAt: true, deletedAt: true } } },
  });
  const member = file && !file.message.deletedAt ? await membershipOf(file.message.chatId, actor.userId) : null;
  const at = file?.message.createdAt;
  if (!file || !member || !at || at < member.joinedAt || (member.leftAt && at > member.leftAt)) throw new ApiError(404, "not_found", "That file isn't there.");
  const { attachmentsViewOnly } = await chatSettings();
  if (attachmentsViewOnly && !opensInBrowser(file.mimeType)) throw new ApiError(403, "view_only", "Files in chat are view-only in this workspace.");
  return new Response(new Uint8Array(file.data), {
    headers: {
      "content-type": opensInBrowser(file.mimeType) ? file.mimeType : "application/octet-stream",
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
});
