import { Readable } from "node:stream";
import { SUPPORT_AGENTS, hasRole } from "@/lib/console-shared/roles";
import { controlConfigured } from "@/lib/platform/control-db";
import { currentStaffSession, type Staff } from "@/lib/platform/staff-session";
import { auditAttachmentOpen, supportAttachmentForStaff, type StaffAttachment } from "@/lib/support/console";
import { FILE_SECURITY_HEADERS, attachmentDisposition, attachmentSize, openAttachment, parseByteRange } from "@/lib/support/storage";

/**
 * A support request's attachment or screen recording, at admin.<domain>/support-files/<id> (the proxy
 * rewrites the console host into /platform-console; this sits outside the `(console)` group, so no
 * layout wraps it). For the staff who act on requests — owners, admins and support — each opening
 * audited as `support.file.open`, once per person per file per ten minutes, since a video player
 * asks for one recording in many ranges.
 *
 * A route handler cannot send anybody to sign in the way a page does, so no session is a 401 and the
 * wrong role a 403. The bytes go out with the type they were sniffed as when uploaded, `nosniff`, no
 * caching, and a sandboxing policy — an attachment opened on its own in a tab can run nothing. Only
 * images and video are shown inline; everything else downloads. Single byte ranges are answered 206,
 * which is what lets a browser seek in a recording. A file removed by retention is 410.
 *
 * HEAD is answered here too, with the same checks and headers but no bytes and no audit row. Without
 * it Next answers a HEAD with GET (node_modules/next/dist/server/route-modules/app-route/helpers/
 * auto-implement-methods.js), and a link checker's or a player's probe would be recorded as somebody
 * opening the file.
 */

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;
const plain = (status: number, message: string, extra: Record<string, string> = {}) => new Response(message, { status, headers: { ...TEXT, ...extra } });
const unsatisfiable = (size: number) => plain(416, "Range not satisfiable.", { "content-range": `bytes */${size}`, "accept-ranges": "bytes" });

type Params = RouteContext<"/platform-console/support-files/[id]">;
type Checked = { staff: Staff; attachment: StaffAttachment; range: { start: number; end: number } | null };

/** Who is asking and for what, as GET and HEAD both need it: the refusal to answer with, or what to serve. */
async function check(request: Request, { params }: Params): Promise<Response | Checked> {
  if (!controlConfigured()) return plain(404, "Not found.");
  const session = await currentStaffSession();
  if (!session || !session.mfaDone) return plain(401, "Sign in to the console.");
  if (!hasRole(session.staff.role, SUPPORT_AGENTS)) return plain(403, "Your role cannot open support attachments.");
  const { id } = await params;
  const attachment = await supportAttachmentForStaff(id);
  if (!attachment) return plain(404, "Not found.");
  if (attachment.purgedAt) return plain(410, "This file was removed when its request's retention period ended.");
  const range = parseByteRange(request.headers.get("range"), attachment.size);
  if (range === "unsatisfiable") return unsatisfiable(attachment.size);
  return { staff: session.staff, attachment, range };
}

/** The headers a served file goes out with — the same for GET and HEAD. */
function fileHeaders(attachment: StaffAttachment, range: Checked["range"], size: number): Record<string, string> {
  const headers: Record<string, string> = {
    ...FILE_SECURITY_HEADERS,
    "Content-Type": attachment.mime,
    "Content-Disposition": attachmentDisposition(attachment.mime, attachment.filename),
    "Accept-Ranges": "bytes",
    "Content-Length": String(range ? range.end - range.start + 1 : size),
  };
  if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${size}`;
  return headers;
}

function failed(err: unknown) {
  // The name only: never the path, the file's name or the request.
  console.error(`[support] an attachment could not be served: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  return plain(503, "The file can't be opened just now. Try again in a moment.", { "retry-after": "30" });
}

export async function GET(request: Request, context: Params) {
  try {
    const checked = await check(request, context);
    if (checked instanceof Response) return checked;
    const { staff, attachment, range } = checked;

    let opened: Awaited<ReturnType<typeof openAttachment>>;
    try {
      opened = await openAttachment(attachment.storageKey, range ?? undefined);
    } catch (err) {
      // The file on disk is shorter than the size recorded for it: a range past its end.
      if (err instanceof RangeError) return unsatisfiable(attachment.size);
      throw err;
    }
    if (!opened) return plain(410, "This file is no longer on the server.");

    try {
      await auditAttachmentOpen(staff, attachment);
    } catch (err) {
      // Every opening is on the record, or the file is not sent.
      opened.stream.destroy();
      throw err;
    }

    const { stream, size } = opened;
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: range ? 206 : 200, headers: fileHeaders(attachment, range, size) });
  } catch (err) {
    return failed(err);
  }
}

/** What GET would answer — status and headers — without opening the file, sending it, or auditing. */
export async function HEAD(request: Request, context: Params) {
  try {
    const checked = await check(request, context);
    if (checked instanceof Response) return new Response(null, { status: checked.status, headers: checked.headers });
    const { attachment, range } = checked;
    const size = await attachmentSize(attachment.storageKey);
    if (size === null) return new Response(null, { status: 410, headers: TEXT });
    if (range && range.end >= size) return new Response(null, { status: 416, headers: { ...TEXT, "content-range": `bytes */${attachment.size}`, "accept-ranges": "bytes" } });
    return new Response(null, { status: range ? 206 : 200, headers: fileHeaders(attachment, range, size) });
  } catch (err) {
    const answer = failed(err);
    return new Response(null, { status: answer.status, headers: answer.headers });
  }
}
