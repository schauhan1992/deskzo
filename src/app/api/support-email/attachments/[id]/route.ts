import { NextResponse } from "next/server";
import { isModuleEnabled } from "@/actions/module";
import { supportEmailAttachment } from "@/actions/support-mail";

/**
 * One file that came with a support email, for whoever may see that email: the ticket's own rule, or the
 * Support inbox's (`supportEmailAttachment`). Anything else — and a guessed id — is not found.
 *
 * Always a download, never shown in the page: the file is whatever a stranger emailed, and an HTML or SVG
 * file opened here would run as this workspace. `nosniff` keeps a browser from deciding otherwise.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("helpdesk"))) return new NextResponse("Not found", { status: 404 });
  const { id } = await context.params;
  const file = await supportEmailAttachment(id).catch(() => null);
  if (!file) return new NextResponse("Not found", { status: 404 });

  const comma = file.dataUrl.indexOf(",");
  if (comma < 0) return new NextResponse("Stored file is unreadable", { status: 500 });
  const body = Buffer.from(file.dataUrl.slice(comma + 1), "base64");
  const name = file.fileName.replace(/["\\\r\n]/g, "").slice(0, 200) || "attachment";

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
