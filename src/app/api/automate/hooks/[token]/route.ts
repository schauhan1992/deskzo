import { NextResponse, type NextRequest } from "next/server";
import { HOOK_LIMITS, receiveWebhook } from "@/lib/automate/webhooks";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";

/**
 * A workflow's webhook address (Deskzo Automate, Phase 4): POST /api/automate/hooks/<token>, on the
 * workspace's own host. Everything about what a call may be is src/lib/automate/webhooks.ts; this reads
 * the request and answers. No session: the address — and, when the workflow asks for it, the signature
 * — is the credential. Outside the proxy altogether (src/proxy.ts matcher), so no body is held beyond
 * 256 KB before this reads it: the workspace is found from the host, and held, here.
 */

export const dynamic = "force-dynamic";

/** The body as text, or null once it passes the limit — read in pieces, so a chunked body with no length can't fill memory. */
async function bodyWithin(req: NextRequest, limit: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The workspace the host names, or the answer to give when there is none to take the call. */
async function workspaceOrAnswer(): Promise<NextResponse | null> {
  const plain = (status: number, error: string, headers: Record<string, string> = {}) => NextResponse.json({ ok: false, error }, { status, headers: { "cache-control": "no-store", ...headers } });
  try {
    const tenant = await currentTenant();
    // Suspended, being set up or migrated, or being restored from a backup: not now.
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return plain(503, "This workspace isn't taking calls just now. Try again shortly.", { "retry-after": "60" });
    return null;
  } catch (err) {
    if (err instanceof TenantHostMismatch) return plain(421, "Misdirected request.");
    if (err instanceof TenantNotFound || err instanceof TenantNotResolved) return plain(404, "No such workspace.");
    throw err;
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const held = await workspaceOrAnswer();
  if (held) return held;
  const tooBig = () => NextResponse.json({ ok: false, error: "The body is over 256 KB." }, { status: 413 });
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > HOOK_LIMITS.bodyBytes) return tooBig();
  const body = await bodyWithin(req, HOOK_LIMITS.bodyBytes);
  if (body === null) return tooBig();
  const answer = await receiveWebhook({ token: (await params).token, body, contentType: req.headers.get("content-type"), headers: req.headers, query: req.nextUrl.searchParams });
  return NextResponse.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store", ...(answer.headers ?? {}) } });
}

export async function GET() {
  return NextResponse.json({ ok: false, error: "Send the data with POST." }, { status: 405, headers: { allow: "POST" } });
}
