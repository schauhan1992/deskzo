import { NextResponse } from "next/server";
import { runHeartbeat } from "@/lib/marketing/heartbeat";
import { forEachTenant, tickTargets } from "@/lib/platform/fanout";
import { fanoutResponse, tickAuthorised } from "@/lib/platform/tick-auth";

/**
 * The scheduler's way in.
 *
 * This app has no job runner, so something outside it has to knock: Windows Task Scheduler on the
 * box, a systemd timer, or a hosted pinger. Every five minutes is the intended cadence — often
 * enough that a scheduled campaign goes out on time, rare enough that it costs nothing.
 *
 *   curl -H "Authorization: Bearer $MARKETING_TICK_SECRET" https://acme.example.com/api/marketing/tick
 *   curl -H "Authorization: Bearer $MARKETING_TICK_SECRET" https://admin.example.com/api/marketing/tick
 *
 * On a workspace's own address it runs that workspace — the answer is the heartbeat's own. On the
 * platform's address (the bare domain or admin.) it runs every active workspace, a few at a time,
 * each on its own (src/lib/platform/fanout.ts), and answers with every workspace's outcome.
 *
 * Under `/api`, so no session is asked for — which is exactly why it has to authenticate itself. It
 * carries the operator's shared secret rather than a session, because a cron job has no session and
 * never will (src/lib/platform/tick-auth.ts).
 */

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!tickAuthorised(request, "MARKETING_TICK_SECRET")) {
    // Deliberately terse, and identical whether the secret is missing or wrong.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { scope, tenants } = await tickTargets(request.headers);
  const outcomes = await forEachTenant("marketing-tick", tenants, () => runHeartbeat(), { concurrency: 4, timeoutMs: 4 * 60_000 });
  if (scope === "platform") return fanoutResponse(outcomes);

  const only = outcomes[0];
  if (!only) return NextResponse.json({ ok: false, error: "No workspace here." }, { status: 404 });
  if ("skipped" in only) return NextResponse.json({ ok: true, skipped: "already-running" });
  if (!only.ok) return NextResponse.json({ ok: false, error: only.error }, { status: 500 });
  return NextResponse.json({ ok: true, ...only.value });
}

/** GET so a plain scheduler can call it; POST so a webhook-style caller can too. */
export const GET = handle;
export const POST = handle;
