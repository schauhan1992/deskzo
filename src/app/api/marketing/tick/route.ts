import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runMarketingTick } from "@/lib/marketing/tick";

/**
 * The scheduler's way in.
 *
 * This app has no job runner, so something outside it has to knock: Windows Task Scheduler on the
 * box, a systemd timer, or a hosted pinger. Every five minutes is the intended cadence — often
 * enough that a scheduled campaign goes out on time, rare enough that it costs nothing.
 *
 *   curl -H "Authorization: Bearer $MARKETING_TICK_SECRET" https://…/api/marketing/tick
 *
 * Under `/api`, so the auth middleware already lets it through (src/middleware.ts) — which is
 * exactly why it has to authenticate itself. It carries a shared secret rather than a session,
 * because a cron job has no session and never will.
 *
 * Without `MARKETING_TICK_SECRET` set, the endpoint refuses everything. An open endpoint that
 * sends mail is worse than a scheduler that never runs.
 */

export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const expected = process.env.MARKETING_TICK_SECRET?.trim();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!provided) return false;

  // Compared in constant time. The lengths are compared first because timingSafeEqual throws on a
  // mismatch, and that throw would itself be a timing signal.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!authorised(request)) {
    // Deliberately terse, and identical whether the secret is missing or wrong.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  // Links in the mail have to be absolute and have to work from outside, so the origin comes from
  // the request rather than an env var nobody would remember to set.
  const origin = forwardedHost ? `${forwardedProto ?? "https"}://${forwardedHost}` : url.origin;

  try {
    const result = await runMarketingTick(origin);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("marketing tick failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "The tick failed." },
      { status: 500 },
    );
  }
}

/** GET so a plain scheduler can call it; POST so a webhook-style caller can too. */
export const GET = handle;
export const POST = handle;
