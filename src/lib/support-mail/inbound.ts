import { createHmac, timingSafeEqual } from "node:crypto";
import { tenantBySlug } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { inboundDomain } from "@/lib/support-mail/config";
import { parseRawEmail } from "@/lib/support-mail/parse";
import { receiveEmail, type Received } from "@/lib/support-mail/receive";
import { slugFromRecipient } from "@/lib/support-mail/rules";

/**
 * The platform's door for tickets by email: what the mail receiver (a Cloudflare Email Worker,
 * deploy/cloudflare/inbound-email-worker.js) posts every email for <anything>@<INBOUND_MAIL_DOMAIN> to.
 *
 *   POST https://<PLATFORM_DOMAIN>/api/platform/inbound-email
 *   X-Deskzo-Timestamp: <unix seconds>
 *   X-Deskzo-Signature: hex(HMAC-SHA256(INBOUND_MAIL_SECRET, "<timestamp>.<body>"))
 *   { "recipient": "wroffy@tickets.deskzo.com", "sender": "…", "raw": "<the email, base64>" }
 *
 * Signed with the one secret the worker and the platform share, within five minutes, compared in
 * constant time — anybody else posting here is refused before the body is read as anything. The
 * recipient names the workspace; one that doesn't exist, isn't active, or hasn't the helpdesk answers
 * 404, which the worker turns into a bounce to the sender. Anything else that fails answers 500, so the
 * sender's mail server tries again later rather than the email being lost.
 */

export const MAX_INBOUND_BYTES = 36 * 1024 * 1024;
const TOLERANCE_SECONDS = 300;

export type InboundAnswer = { status: number; body: { ok: boolean; error?: string; result?: Received } };

/** Whether this body was signed with the shared secret, recently. */
export function verifyInbound(body: string, timestamp: string | null, signature: string | null, secret: string | undefined, now = Date.now()): boolean {
  if (!secret || secret.length < 16 || !timestamp || !signature || !/^\d{9,11}$/.test(timestamp) || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function receiveInbound(body: string, headers: Headers): Promise<InboundAnswer> {
  if (!verifyInbound(body, headers.get("x-deskzo-timestamp"), headers.get("x-deskzo-signature"), process.env.INBOUND_MAIL_SECRET)) {
    return { status: 401, body: { ok: false, error: "Not signed." } };
  }
  const domain = inboundDomain();
  if (!domain) return { status: 404, body: { ok: false, error: "This platform receives no mail." } };

  let payload: { recipient?: unknown; raw?: unknown };
  try {
    payload = JSON.parse(body) as typeof payload;
  } catch {
    return { status: 400, body: { ok: false, error: "Not JSON." } };
  }
  const slug = typeof payload.recipient === "string" ? slugFromRecipient(payload.recipient, domain) : null;
  if (!slug || typeof payload.raw !== "string") return { status: 404, body: { ok: false, error: "No helpdesk answers at this address." } };

  const tenant = await tenantBySlug(slug);
  if (!tenant || tenant.status !== "ACTIVE") return { status: 404, body: { ok: false, error: "No helpdesk answers at this address." } };

  const raw = new Uint8Array(Buffer.from(payload.raw, "base64"));
  return runAsTenant(tenant, async () => {
    if (!(await moduleAvailableForTenant("helpdesk"))) return { status: 404, body: { ok: false, error: "No helpdesk answers at this address." } };
    const result = await receiveEmail(await parseRawEmail(raw));
    return { status: 200, body: { ok: true, result } };
  });
}
