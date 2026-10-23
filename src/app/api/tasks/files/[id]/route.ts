import { contentDisposition } from "@/lib/content-disposition";
import { db } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { moduleAccessFor } from "@/lib/modules-access";
import { taskAccess } from "@/lib/authz/access";
import { opensInBrowser } from "@/lib/chat/rules";

/**
 * A file on a task (owner, 16 Oct 2026), to somebody who may see the task and nobody else — checked on
 * every fetch, which a link straight to the bytes could not do. Pictures, PDFs and text open in the
 * browser; `?download=1`, or anything else, is saved.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await moduleAccessFor(user.id, "tasks")) !== "available") return new Response("Not found", { status: 404 });
  const { id } = await context.params;

  const file = await db.taskAttachment.findUnique({ where: { id }, select: { fileName: true, mimeType: true, data: true, taskId: true } });
  if (!file) return new Response("Not found", { status: 404 });
  const visible = await db.task.count({ where: { AND: [{ id: file.taskId }, await taskAccess(user.id, "view")] } });
  if (!visible) return new Response("Not found", { status: 404 });

  const inline = new URL(request.url).searchParams.get("download") !== "1" && opensInBrowser(file.mimeType);
  return new Response(new Uint8Array(file.data), {
    headers: {
      // Only what a browser shows safely is labelled as itself; anything else is just bytes.
      "content-type": inline ? file.mimeType : "application/octet-stream",
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", file.fileName),
      "x-content-type-options": "nosniff",
      // A file opened on its own can't run anything in the app's name. Not on a PDF: Chrome won't show
      // one under a sandbox, and its viewer runs apart from the page anyway.
      ...(file.mimeType === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
      "cache-control": "private, no-store",
    },
  });
}
