import { NextResponse } from "next/server";
import { runBillingLifecycle } from "@/lib/billing/lifecycle";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { reconcileSubscriptions, snapshotUsage } from "@/lib/billing/reconcile";
import { istDateParts } from "@/lib/india-time";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { withPlatformLease } from "@/lib/platform/fanout";
import { tickAuthorised } from "@/lib/platform/tick-auth";

/**
 * The platform's own scheduled chores, on its own address only:
 *
 *   curl -H "Authorization: Bearer $PLATFORM_TICK_SECRET" https://admin.example.com/api/platform/tick
 *
 * Every hour is the intended cadence. Each call applies every workspace's billing standing — trials
 * ending, grace running out, holds lifted, reminders (src/lib/billing/lifecycle.ts). Once a day, the
 * first call also reads every gateway subscription back and records each workspace's use
 * (src/lib/billing/reconcile.ts). Under a lease, so two schedulers never run it at once.
 */

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!tickAuthorised(request, "PLATFORM_TICK_SECRET")) return NextResponse.json({ ok: false }, { status: 401 });
  if (!onPlatformHost(request)) return NextResponse.json({ ok: false, error: "The platform tick runs on the platform's own address." }, { status: 404 });

  const ran = await withPlatformLease("platform-tick", 30 * 60_000, async () => {
    const lifecycle = await runBillingLifecycle();
    const { year, month, day } = istDateParts(new Date());
    const today = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let daily: { reconciled: number; failed: string[]; usage: number } | null = null;
    if ((await getSetting("billing.dailyRanOn")) !== today) {
      const reconciled = await reconcileSubscriptions();
      const usage = await snapshotUsage();
      await setSetting("billing.dailyRanOn", today, "tick");
      daily = { reconciled: reconciled.read, failed: reconciled.failed, usage: usage.length };
    }
    return {
      held: lifecycle.filter((o) => o.action === "held").map((o) => o.slug),
      lifted: lifecycle.filter((o) => o.action === "lifted").map((o) => o.slug),
      closed: lifecycle.filter((o) => o.action === "closed").map((o) => o.slug),
      reminded: lifecycle.filter((o) => o.reminded).map((o) => o.slug),
      daily,
    };
  });
  if (!ran.ran) return NextResponse.json({ ok: true, skipped: "already-running" });
  return NextResponse.json({ ok: !ran.value.daily?.failed.length, ...ran.value });
}

export const GET = handle;
export const POST = handle;
