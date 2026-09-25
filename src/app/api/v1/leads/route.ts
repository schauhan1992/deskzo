import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseBasicAuth, secretMatches } from "@/lib/lead-capture/credentials";
import { intakeLead, leadPayloadSchema } from "@/lib/lead-capture/intake";
import { MAX_BODY_BYTES, RATE_LIMIT_PER_MINUTE } from "@/lib/lead-capture/spec";

/**
 * The lead capture API — POST a website enquiry, get a lead.
 *
 * Documented for website developers on Settings → Lead capture API (and as downloadable Markdown),
 * both generated from src/lib/lead-capture/spec.ts. Outside the proxy's matcher like every /api
 * route, so there is no session here: the key is the whole of the authentication.
 *
 * ## What is refused, and how
 *
 *   · No key, a wrong secret, a revoked key: 401, identical in every case and the same shape as
 *     for a key that never existed — so the endpoint cannot be used to find out which key IDs are
 *     real. The secret is compared as a digest, in constant time.
 *   · Over 64 KB, or not JSON or a form: 413 / 415, before anything is parsed.
 *   · More than 60 leads a minute from one key: 429 with Retry-After. A form being spammed, or a
 *     loop in somebody's code, is stopped at one key without affecting the other websites.
 *
 * No CORS headers are sent, on purpose: a browser will not make this call, so a secret pasted into
 * page JavaScript fails straight away instead of being quietly exposed to every visitor.
 */

export const dynamic = "force-dynamic";

const deny = () => NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Wroffy ERP lead capture"' } });

async function authenticate(request: Request) {
  const credentials = parseBasicAuth(request.headers.get("authorization"));
  if (!credentials) return null;
  const key = await db.leadCaptureKey.findUnique({ where: { keyId: credentials.keyId } });
  // The digest is computed even when there is no such key, so a wrong ID and a wrong secret take
  // the same time — a timing difference would tell a caller which key IDs exist.
  const ok = secretMatches(credentials.secret, key?.secretDigest ?? "x".repeat(44));
  if (!key || !ok || !key.active || key.revokedAt) return null;
  return key;
}

/** Checks a key works, without creating anything. */
export async function GET(request: Request) {
  const key = await authenticate(request);
  if (!key) return deny();
  return NextResponse.json({ ok: true, key: key.name });
}

export async function POST(request: Request) {
  const key = await authenticate(request);
  if (!key) return deny();

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: `The body is over ${MAX_BODY_BYTES / 1024} KB.` }, { status: 413 });
  }

  const recent = await db.lead.count({
    where: { captureKeyId: key.id, createdAt: { gt: new Date(Date.now() - 60_000) } },
  });
  if (recent >= RATE_LIMIT_PER_MINUTE) {
    return NextResponse.json(
      { ok: false, error: `More than ${RATE_LIMIT_PER_MINUTE} leads a minute from this key. Try again shortly.` },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // Read as text first, so the size limit holds even when Content-Length was missing or wrong.
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: `The body is over ${MAX_BODY_BYTES / 1024} KB.` }, { status: 413 });
  }

  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  let body: Record<string, unknown>;
  try {
    if (type.includes("application/json")) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } else if (type.includes("application/x-www-form-urlencoded")) {
      body = Object.fromEntries(new URLSearchParams(raw));
      // A form cannot send an array; products come as "SKU1,SKU2".
      if (typeof body.products === "string") body.products = body.products.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      return NextResponse.json({ ok: false, error: "Send application/json or application/x-www-form-urlencoded." }, { status: 415 });
    }
  } catch {
    return NextResponse.json({ ok: false, error: "The body is not valid JSON." }, { status: 400 });
  }

  const payload = leadPayloadSchema.safeParse(body);
  if (!payload.success) {
    const fields: Record<string, string> = {};
    for (const issue of payload.error.issues) fields[String(issue.path[0] ?? "body")] ??= issue.message;
    return NextResponse.json({ ok: false, error: payload.error.issues[0]?.message ?? "Invalid request", fields }, { status: 400 });
  }

  // Counted for the settings page; not part of the decision above, which counts leads created.
  await db.leadCaptureKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date(), useCount: { increment: 1 } } });

  try {
    const result = await intakeLead(key, payload.data);
    if (result.status === "reseller") {
      return NextResponse.json(
        { ok: true, routed: "reseller", message: "Received. This company is looked after by one of our partners; the enquiry has been passed to them." },
        { status: 202 },
      );
    }
    if (result.status === "duplicate") {
      return NextResponse.json({ ok: true, lead: { id: result.leadId, reference: result.reference }, duplicate: true }, { status: 200 });
    }
    return NextResponse.json(
      { ok: true, lead: { id: result.leadId, reference: result.reference }, duplicate: false, assigned: result.assigned },
      { status: 201 },
    );
  } catch (error) {
    console.error("lead capture failed", error);
    return NextResponse.json({ ok: false, error: "The lead could not be saved. Please try again." }, { status: 500 });
  }
}
