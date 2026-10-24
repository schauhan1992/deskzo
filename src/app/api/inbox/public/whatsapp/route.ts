import { NextResponse, type NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { restoreInProgressFor } from "@/lib/backup/maintenance";
import { decryptSecret } from "@/lib/crypto";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { applyWhatsAppStatus, inboxSettings, receiveWhatsApp } from "@/lib/inbox/server";
import { parseWebhook, verifySignature } from "@/lib/inbox/whatsapp";
import { TenantHostMismatch, TenantNotFound, TenantNotResolved, currentTenant } from "@/lib/tenancy/resolve";

/**
 * Meta's WhatsApp webhook for the Customer inbox, on the workspace's own address — set up in the
 * workspace's Meta app with the token from Settings › Customer inbox (src/lib/inbox/whatsapp.ts).
 *
 *   GET   Meta checking the address: the verify token must match, and the challenge is echoed.
 *   POST  messages and receipts, signed with the Meta app's secret (X-Hub-Signature-256). Nothing is
 *         read until the signature checks out. A message already kept is skipped — Meta retries — and
 *         a failure answers 500 so Meta tries again later.
 *
 * Outside the proxy (src/proxy.ts matcher): the workspace is found from the host here.
 */

export const dynamic = "force-dynamic";

const BODY_LIMIT = 1024 * 1024;

async function workspace(): Promise<NextResponse | null> {
  try {
    const tenant = await currentTenant();
    if (tenant.status !== "ACTIVE" || restoreInProgressFor(tenant)) return NextResponse.json({ ok: false }, { status: 503, headers: { "retry-after": "60" } });
    return null;
  } catch (err) {
    if (err instanceof TenantHostMismatch || err instanceof TenantNotFound || err instanceof TenantNotResolved) return NextResponse.json({ ok: false }, { status: 404 });
    throw err;
  }
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function GET(req: NextRequest) {
  const held = await workspace();
  if (held) return held;
  const q = req.nextUrl.searchParams;
  const settings = await inboxSettings();
  if (q.get("hub.mode") !== "subscribe" || !same(q.get("hub.verify_token") ?? "", settings.whatsappVerifyToken)) return new Response("Forbidden", { status: 403 });
  return new Response((q.get("hub.challenge") ?? "").slice(0, 200), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  const held = await workspace();
  if (held) return held;
  if (Number(req.headers.get("content-length") ?? 0) > BODY_LIMIT) return NextResponse.json({ ok: false }, { status: 413 });
  const raw = await req.text();
  if (raw.length > BODY_LIMIT) return NextResponse.json({ ok: false }, { status: 413 });

  const settings = await inboxSettings();
  const secret = settings.whatsappAppSecretCipher ? await decryptSecret(settings.whatsappAppSecretCipher).catch(() => null) : null;
  if (!secret || !verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) return NextResponse.json({ ok: false }, { status: 401 });
  // Signed, but the inbox isn't in the plan (or is switched off): taken, and dropped, so Meta stops retrying.
  if (!(await moduleAvailableForTenant("inbox"))) return NextResponse.json({ ok: true, ignored: true });

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const { messages, statuses } = parseWebhook(body);
  try {
    for (const m of messages) await receiveWhatsApp(m);
    for (const st of statuses) await applyWhatsAppStatus(st);
  } catch (err) {
    console.error("[inbox] a WhatsApp delivery couldn't be kept; Meta will retry", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
