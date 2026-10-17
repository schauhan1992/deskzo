import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { currentKeys } from "@/lib/tenancy/keys";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { requestWakeHere } from "@/lib/automate/wake";
import { signature } from "@/lib/automate/outbound";

/**
 * A workflow started by an outside app (Deskzo Automate, Phase 4): its own address, POST
 * /api/automate/hooks/<token>, on the workspace's own host.
 *
 *   · The address is unguessable, and is how the call is found: only its hash is stored. Both it and the
 *     signing secret are derived from the workspace's keys and the address's id — nothing secret is
 *     stored, an admin can always see them again, and a new address replaces the old.
 *   · A call may be signed — X-Deskzo-Timestamp, and X-Deskzo-Signature: hex HMAC-SHA256 of
 *     "<timestamp>.<body>" with the secret — and must be within 5 minutes when it is. A wrong or stale
 *     signature is refused. A workflow may take only signed calls; otherwise the address alone is enough,
 *     for senders that can't sign.
 *   · JSON or form bodies up to 256 KB. A call repeated with the same Idempotency-Key within 24 hours is
 *     answered 200 and runs nothing. 60 calls a minute per address, then 429 with Retry-After.
 *   · The call is answered 202 as soon as it is recorded, as an event the workflow alone matches; the
 *     run happens in the worker (src/lib/automate/engine.ts).
 */

export const HOOK_LIMITS = { bodyBytes: 256 * 1024, perMinute: 60, skewSeconds: 300, idempotencyHours: 24 } as const;

async function derive(purpose: string, hookId: string): Promise<string> {
  const { digestKey } = await currentKeys();
  return createHmac("sha256", digestKey).update(`deskzo/automate-hook/${purpose}:${hookId}`).digest("base64url").slice(0, 40);
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export type WebhookView = { id: string; address: string; secret: string; requireSignature: boolean; lastReceivedAt: Date | null; sampleKeys: string[] };

async function view(row: { id: string; requireSignature: boolean; lastReceivedAt: Date | null; workflowId: string }): Promise<WebhookView> {
  const token = await derive("address", row.id);
  const last = await db.automationEvent.findFirst({ where: { type: "webhook", recordId: { startsWith: `${row.id}:` } }, orderBy: { occurredAt: "desc" }, select: { payload: true } });
  const body = (last?.payload as { body?: unknown } | null)?.body;
  return {
    id: row.id,
    address: `${await tenantOrigin()}/api/automate/hooks/${token}`,
    secret: await derive("signing", row.id),
    requireSignature: row.requireSignature,
    lastReceivedAt: row.lastReceivedAt,
    sampleKeys: body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 40) : [],
  };
}

/** A workflow's address, if it has one. */
export async function webhookOf(workflowId: string): Promise<WebhookView | null> {
  const row = await db.automationWebhook.findFirst({ where: { workflowId }, orderBy: { createdAt: "desc" }, select: { id: true, workflowId: true, requireSignature: true, lastReceivedAt: true } });
  return row ? view(row) : null;
}

/** A workflow's address — made the first time it is asked for; `fresh` replaces any it had. */
export async function ensureWebhook(workflowId: string, fresh = false): Promise<WebhookView> {
  const existing = fresh ? null : await webhookOf(workflowId);
  if (existing) return existing;
  const before = await db.automationWebhook.findFirst({ where: { workflowId }, orderBy: { createdAt: "desc" }, select: { requireSignature: true } });
  const id = randomUUID();
  const created = await db.$transaction(async (tx) => {
    await tx.automationWebhook.deleteMany({ where: { workflowId } });
    return tx.automationWebhook.create({
      data: { id, workflowId, tokenHash: hashOf(await derive("address", id)), requireSignature: before?.requireSignature ?? false },
      select: { id: true, workflowId: true, requireSignature: true, lastReceivedAt: true },
    });
  });
  return view(created);
}

export async function setRequireSignature(workflowId: string, required: boolean): Promise<void> {
  await db.automationWebhook.updateMany({ where: { workflowId }, data: { requireSignature: required } });
}

export type WebhookCall = { token: string; body: string; contentType: string | null; headers: Headers; query: URLSearchParams; now?: Date };
export type WebhookAnswer = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const refuse = (status: number, error: string, headers?: Record<string, string>): WebhookAnswer => ({ status, body: { ok: false, error }, headers });

function constantEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What the call carried, as data the workflow reads: JSON, a form's fields, or the text. */
export function readBody(body: string, contentType: string | null): unknown {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(body));
  if (type.includes("json") || /^\s*[[{]/.test(body)) {
    try {
      return JSON.parse(body);
    } catch {
      /* not JSON after all */
    }
  }
  return { text: body };
}

/** Takes one call to an address — or refuses it, saying why in the answer. In the workspace the host names. */
export async function receiveWebhook(call: WebhookCall): Promise<WebhookAnswer> {
  const now = call.now ?? new Date();
  if (!(await moduleAvailableForTenant("automate"))) return refuse(404, "Not found.");
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(call.token)) return refuse(404, "Not found.");
  const hook = await db.automationWebhook.findUnique({
    where: { tokenHash: hashOf(call.token) },
    select: { id: true, workflowId: true, requireSignature: true, workflow: { select: { status: true, triggers: { select: { type: true } } } } },
  });
  if (!hook) return refuse(404, "Not found.");
  if (hook.workflow.status !== "ACTIVE" || hook.workflow.triggers[0]?.type !== "webhook") return refuse(409, "This workflow isn't switched on to take calls.");
  if (Buffer.byteLength(call.body) > HOOK_LIMITS.bodyBytes) return refuse(413, "The body is over 256 KB.");

  // Signed: believed only if right and recent. Unsigned: only where the workflow allows it.
  const timestamp = call.headers.get("x-deskzo-timestamp");
  const signed = call.headers.get("x-deskzo-signature");
  if (timestamp || signed) {
    const seconds = Number(timestamp);
    if (!timestamp || !signed || !Number.isFinite(seconds)) return refuse(401, "Both X-Deskzo-Timestamp and X-Deskzo-Signature are needed to sign a call.");
    if (Math.abs(now.getTime() / 1000 - seconds) > HOOK_LIMITS.skewSeconds) return refuse(401, "The signature's timestamp is more than 5 minutes out.");
    if (!constantEqual(signature(await derive("signing", hook.id), timestamp, call.body), signed.trim().toLowerCase())) return refuse(401, "The signature doesn't match.");
  } else if (hook.requireSignature) {
    return refuse(401, "This address takes only signed calls.");
  }

  const prefix = `${hook.id}:`;
  const recent = await db.automationEvent.count({ where: { type: "webhook", recordId: { startsWith: prefix }, occurredAt: { gte: new Date(now.getTime() - 60_000) } } });
  if (recent >= HOOK_LIMITS.perMinute) return refuse(429, "More than 60 calls in a minute. Try again shortly.", { "retry-after": "60" });

  const key = call.headers.get("idempotency-key")?.trim().slice(0, 200) || null;
  const recordId = `${prefix}${key ?? randomUUID()}`;
  const payload = {
    workflowId: hook.workflowId,
    body: readBody(call.body, call.contentType),
    query: Object.fromEntries(call.query),
    headers: { contentType: call.contentType, userAgent: call.headers.get("user-agent"), signed: !!signed },
    receivedAt: now.toISOString(),
  };
  // Written here rather than through emitEvents, which swallows a failure so a business write never
  // fails for its event: here the event is the write, and a caller told 202 must be able to rely on it.
  let duplicate: boolean;
  try {
    duplicate = await db.$transaction(async (tx) => {
      if (key) {
        // Two calls racing with the same key: the second waits, then finds the first.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automate-hook:${recordId}`}))`;
        const since = new Date(now.getTime() - HOOK_LIMITS.idempotencyHours * 3_600_000);
        if (await tx.automationEvent.findFirst({ where: { type: "webhook", recordId, occurredAt: { gte: since } }, select: { id: true } })) return true;
      }
      await tx.automationEvent.create({ data: { type: "webhook", recordType: "webhook", recordId, payload: payload as unknown as Prisma.InputJsonValue } });
      await tx.automationWebhook.update({ where: { id: hook.id }, data: { lastReceivedAt: now } });
      return false;
    });
  } catch (err) {
    if (notMigratedYet(err)) return refuse(503, "Not ready yet. Try again shortly.", { "retry-after": "60" });
    throw err;
  }
  if (duplicate) return { status: 200, body: { ok: true, accepted: true, duplicate: true } };
  // A moment ahead, so the transaction is visible by the time the worker looks.
  void requestWakeHere(new Date(Date.now() + 1_000));
  return { status: 202, body: { ok: true, accepted: true } };
}

