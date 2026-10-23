import { contentDisposition } from "@/lib/content-disposition";
import { NextResponse } from "next/server";
import { getEmployeeDocument } from "@/actions/employee-docs";

/**
 * Serves one file off a personnel file.
 *
 * A route rather than a link straight to the data URL, because the access check has to run on every
 * fetch: whether you may read a document depends on who you are, whether it is yours, and whether
 * HR marked it internal — none of which a `data:` URL in the page can enforce once it has been
 * rendered. `getEmployeeDocument` returns null rather than throwing for anything you may not see,
 * so a guessed id is indistinguishable from a deleted one.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const doc = await getEmployeeDocument(id);
  if (!doc) return new NextResponse("Not found", { status: 404 });

  const comma = doc.fileDataUrl.indexOf(",");
  if (comma < 0) return new NextResponse("Stored file is unreadable", { status: 500 });
  const body = Buffer.from(doc.fileDataUrl.slice(comma + 1), "base64");

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": doc.mimeType || "application/octet-stream",
      // `inline` so a PDF opens in the tab rather than landing in Downloads; the filename is still
      // there for whoever chooses to save it.
      "Content-Disposition": contentDisposition("inline", doc.name),
      // Personnel documents must not sit in a shared cache.
      "Cache-Control": "private, no-store",
      // As the chat's and tasks' files are served (security review, 23 Oct 2026): never taken for anything but what it
      // says it is, and — a PDF apart, which Chrome won't show under a sandbox — unable to run anything in the app's name.
      "X-Content-Type-Options": "nosniff",
      ...(doc.mimeType === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'" }),
    },
  });
}
