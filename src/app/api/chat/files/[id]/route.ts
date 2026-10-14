import { db } from "@/lib/db";
import { currentUser, viewAsContext } from "@/lib/session";
import { chatSettings, membershipOf } from "@/lib/chat/server";
import { opensInBrowser } from "@/lib/chat/rules";

/**
 * One file sent in a chat, to one of that chat's members and nobody else — checked on every fetch,
 * which a link straight to the bytes could not do.
 *
 * `?download=1` saves it, unless the workspace keeps chat files view-only (Settings → Chat): then
 * pictures, PDFs and text open in the browser and nothing is offered as a download. That is a
 * deterrent, like the rest of the DLP layer — a browser can still save what it shows.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await viewAsContext())) return new Response("Not found", { status: 404 });
  const { id } = await context.params;

  const file = await db.chatAttachment.findUnique({
    where: { id },
    select: { fileName: true, mimeType: true, data: true, message: { select: { chatId: true, createdAt: true, deletedAt: true } } },
  });
  if (!file || file.message.deletedAt) return new Response("Not found", { status: 404 });
  const member = await membershipOf(file.message.chatId, user.id);
  const at = file.message.createdAt;
  if (!member || at < member.joinedAt || (member.leftAt && at > member.leftAt)) return new Response("Not found", { status: 404 });

  const { attachmentsViewOnly } = await chatSettings();
  const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
  if (attachmentsViewOnly && (wantsDownload || !opensInBrowser(file.mimeType))) {
    return new Response("Files in chat are view-only in this workspace.", { status: 403 });
  }
  const inline = !wantsDownload && opensInBrowser(file.mimeType);
  const name = file.fileName.replace(/["\r\n]/g, "");

  return new Response(new Uint8Array(file.data), {
    headers: {
      // Only what a browser shows safely is labelled as itself; anything else is just bytes.
      "content-type": inline ? file.mimeType : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "x-content-type-options": "nosniff",
      // A file opened on its own can't run anything in the app's name. Not on a PDF: Chrome won't show
      // one under a sandbox, and its viewer runs apart from the page anyway.
      ...(file.mimeType === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "cache-control": "private, no-store",
    },
  });
}
