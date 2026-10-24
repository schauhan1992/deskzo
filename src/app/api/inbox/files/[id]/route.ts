import { contentDisposition } from "@/lib/content-disposition";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentUser } from "@/lib/session";
import { conversationFile } from "@/lib/inbox/server";

/**
 * A file a customer sent on WhatsApp — a photo, a document, a voice note — to somebody who may read that
 * conversation (src/lib/inbox/server.ts `conversationFile`), checked on every fetch. Fetched from Meta
 * the first time it's opened and kept after that. `?download=1` saves it.
 *
 * Under /api the proxy doesn't stand in front of this, so it makes its own checks: signed in, the inbox
 * open to them, and "Answer customer conversations".
 */
export const dynamic = "force-dynamic";

/** What a browser shows safely as itself; anything else goes as bytes to save. Never SVG or HTML. */
const INLINE = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "video/mp4", "video/3gpp"]);

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 });
  const user = await currentUser();
  if (!user) return new Response("Not found", { status: 404 });
  if ((await moduleAccessFor(user.id, "inbox")) !== "available" || !(await can(user.id, "inbox.view"))) return new Response("Not found", { status: 404 });
  const { id } = await context.params;

  const file = await conversationFile({ id: user.id, viewAll: await can(user.id, "inbox.viewAll") }, id);
  if (!file.ok) return new Response(file.error, { status: file.status, headers: { "content-type": "text/plain; charset=utf-8" } });

  const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
  const inline = !wantsDownload && INLINE.has(file.mime);
  const name = file.name ?? `whatsapp-file.${file.mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin"}`;
  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "content-type": inline ? file.mime : "application/octet-stream",
      "content-disposition": contentDisposition(inline ? "inline" : "attachment", name),
      "x-content-type-options": "nosniff",
      // Opened on its own, a file can't run anything in the app's name. Not on a PDF, which Chrome won't show sandboxed.
      ...(file.mime === "application/pdf" ? {} : { "content-security-policy": "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" }),
      "cache-control": "private, no-store",
    },
  });
}
