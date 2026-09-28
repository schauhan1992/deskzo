import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { NextResponse } from "next/server";
import { throttle } from "@/lib/security/throttle";
import { SupportRefused } from "@/lib/support/refused";
import { resolveRequester } from "@/lib/support/requester";
import { STAGING_LIMITS, discardStaged, stageUpload, stagedBytesFor, uploadCap, validId } from "@/lib/support/storage";
import { UPLOAD_HEADERS, type SupportUploadKind, type UploadError, type UploadResponse } from "@/lib/support/types";
import { requestHost } from "@/lib/tenancy/host";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Contact Support's attachments, uploaded as soon as they are chosen — so pressing Send only claims
 * them (src/actions/support.ts) — and kept in staging until then (src/lib/support/storage.ts).
 *
 *   POST    the raw file as the body (not multipart, as src/app/api/backups/upload does, so a
 *           recording streams to disk a chunk at a time), with
 *             x-support-kind: file | recording
 *             x-file-name:    the file's name, encodeURIComponent-ed
 *             x-support-upload: 1
 *           → 200 { uploadId, filename, size, mime }, or an error status with { error }.
 *   DELETE  ?id=<uploadId>, with x-support-upload: 1 — takes back one of your own staged uploads.
 *
 * A route handler gets none of the checks a server action gets for free, so each is made here:
 * the Origin must be this host (a page elsewhere can't post a file with somebody's cookie), and the
 * marker header must be there (a plain cross-site form can't set one). Then the same "who may ask"
 * as the dialog (src/lib/support/requester.ts): signed in, as themselves, not platform support, and
 * support switched on. A recording also needs recording to be allowed for them.
 *
 * Limits: 10 MB a file and 80 MB a recording — a declared length over it is refused before a byte is
 * read, and the bytes are counted as they arrive regardless; 30 uploads an hour a person; 150 MB
 * waiting in staging a person. What a file is comes from its bytes: anything that can't be attached
 * is deleted and refused.
 */

export const dynamic = "force-dynamic";

const HOUR_MS = 3_600_000;

function fail(status: number, error: string) {
  return NextResponse.json<UploadError>({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

/** The request came from a page of this host, and carries the marker a cross-site form can't send. */
function sameOriginWithMarker(request: Request): boolean {
  if (request.headers.get(UPLOAD_HEADERS.marker) !== "1") return false;
  const origin = request.headers.get("origin");
  // The real host of this request (see src/lib/tenancy/host.ts) — a forwarded one is only a claim.
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  try {
    return !!origin && !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

function fileName(request: Request): string {
  const raw = request.headers.get(UPLOAD_HEADERS.fileName) ?? "";
  try {
    return decodeURIComponent(raw).slice(0, 1000);
  } catch {
    return raw.slice(0, 1000);
  }
}

export async function POST(request: Request) {
  if (!sameOriginWithMarker(request)) return fail(403, "Uploads are only accepted from this app.");
  const kindHeader = request.headers.get(UPLOAD_HEADERS.kind);
  if (kindHeader !== "file" && kindHeader !== "recording") return fail(400, "Say whether this is a file or a recording.");
  const kind: SupportUploadKind = kindHeader;
  const cap = uploadCap(kind);
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > cap) return fail(413, kind === "recording" ? "That recording is over 80 MB." : "That file is over 10 MB.");

  const who = await resolveRequester({ fresh: true });
  if (!who.ok) return fail(who.status, who.error);
  const { tenant, user, recording } = who.requester;
  if (kind === "recording" && !recording.allowed) {
    return fail(403, recording.blockedReason === "dlp" ? "Your organisation's security settings don't allow screen recording." : "Screen recording isn't available right now.");
  }

  const perHour = throttle(`${await tenantKey()}|support-upload:${user.id}`, HOUR_MS);
  if (!perHour.write && perHour.suppressedSince >= STAGING_LIMITS.uploadsPerHour) return fail(429, "You've added a lot of files recently — please wait a few minutes.");

  const waiting = await stagedBytesFor(tenant.id, user.id);
  const room = STAGING_LIMITS.bytesPerUser - waiting;
  if (room <= 0 || (Number.isFinite(declared) && declared > room)) return fail(413, "You have too many attachments waiting to be sent — send or remove some first.");
  if (!request.body) return fail(400, "No file was sent.");

  try {
    const staged = await stageUpload(Readable.fromWeb(request.body as NodeReadableStream<Uint8Array>), {
      tenantId: tenant.id,
      userId: user.id,
      kind,
      filename: fileName(request),
      maxBytes: Math.min(cap, room),
    });
    return NextResponse.json<UploadResponse>({ uploadId: staged.uploadId, filename: staged.filename, size: staged.size, mime: staged.mime }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof SupportRefused) return fail(err.status, err.message);
    console.error(`[support] an upload failed: ${err instanceof Error ? err.name : "error"}`);
    return fail(500, "The upload didn't finish. Please try again.");
  }
}

export async function DELETE(request: Request) {
  if (!sameOriginWithMarker(request)) return fail(403, "Uploads are only accepted from this app.");
  const id = new URL(request.url).searchParams.get("id");
  if (!validId(id)) return fail(404, "That attachment isn't there.");
  const who = await resolveRequester({ fresh: true });
  if (!who.ok) return fail(who.status, who.error);
  const { tenant, user } = who.requester;
  // Only ever one's own: another person's id answers exactly like one that doesn't exist.
  if (!(await discardStaged(tenant.id, user.id, id))) return fail(404, "That attachment isn't there.");
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
