import { NextResponse } from "next/server";
import { runBillingLifecycle } from "@/lib/billing/lifecycle";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { reconcileSubscriptions, snapshotUsage } from "@/lib/billing/reconcile";
import { redactSecrets } from "@/lib/console-shared/redact";
import { istDateParts } from "@/lib/india-time";
import { runPartnerChores } from "@/lib/partners/commission";
import { reconcileEmailIndex } from "@/lib/platform/email-index";
import { sweepLinkedSignIn } from "@/lib/platform/linked/sweep";
import { snapshotRevenue } from "@/lib/platform/revenue";
import { getSetting, setSetting } from "@/lib/platform/settings";
import { withPlatformLease } from "@/lib/platform/fanout";
import { tickAuthorised } from "@/lib/platform/tick-auth";
import { recordTick } from "@/lib/platform/tick-summary";
import { runSupportRetention } from "@/lib/support/retention";

/**
 * The platform's own scheduled chores, on its own address only:
 *
 *   curl -H "Authorization: Bearer $PLATFORM_TICK_SECRET" https://admin.example.com/api/platform/tick
 *
 * Every hour is the intended cadence. Each call applies every workspace's billing standing — trials
 * ending, grace running out, holds lifted, reminders (src/lib/billing/lifecycle.ts). Once a day, the
 * first call also reads every gateway subscription back, records each workspace's use
 * (src/lib/billing/reconcile.ts) and the day's revenue (src/lib/platform/revenue.ts). Under a lease,
 * so two schedulers never run it at once — nor a run started from the console.
 *
 * The daily call also runs linked sign-in's nightly sweep (src/lib/platform/linked/sweep.ts) and brings the
 * "find my workspace" email index up to date (src/lib/platform/email-index.ts), each failing into the day's
 * `failed` without stopping anything else.
 *
 * Every call also tidies Contact Support's files (src/lib/support/retention.ts): uploads never sent
 * go after a day, and closed requests' files after the retention the console sets. A failure there is
 * reported in the result and fails nothing else.
 *
 * Every call also works out partners' commission on the invoices paid or changed since the last one
 * (src/lib/partners/commission.ts); the daily call also expires deal registrations past their date and,
 * from the programme's statement day of the IST month on, drafts last month's partner statements. Under
 * a lease of its own ("partner-commissions"): a run still going elsewhere is skipped, and a failure
 * there is counted in the result, never allowed to fail the billing chores.
 *
 * What it did is kept as the last tick's summary (src/lib/platform/tick-summary.ts), which the
 * console's Billing and Health pages show.
 */

export const dynamic = "force-dynamic";

async function handle(request: Request) {
  if (!tickAuthorised(request, "PLATFORM_TICK_SECRET")) return NextResponse.json({ ok: false }, { status: 401 });
  if (!onPlatformHost(request)) return NextResponse.json({ ok: false, error: "The platform tick runs on the platform's own address." }, { status: 404 });

  const ran = await withPlatformLease("platform-tick", 30 * 60_000, async () => {
    const started = Date.now();
    const now = new Date();
    const lifecycle = await runBillingLifecycle(now);
    const { year, month, day } = istDateParts(now);
    const today = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let daily: { reconciled: number; failed: string[]; usage: number; revenue: number } | null = null;
    if ((await getSetting("billing.dailyRanOn")) !== today) {
      const reconciled = await reconcileSubscriptions();
      const usage = await snapshotUsage();
      const failed = [...reconciled.failed];
      // After the reconcile, so the day's figure reflects what the gateways said today.
      let revenue = 0;
      try {
        revenue = await snapshotRevenue(now);
      } catch (err) {
        failed.push(`revenue: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Linked sign-in's sweep and the email index: each reports into the day's failures, never stops the day.
      try {
        const s = await sweepLinkedSignIn(now);
        failed.push(...s.failed.map((f) => `linked: ${f}`));
      } catch (err) {
        failed.push(`linked: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        const e = await reconcileEmailIndex();
        failed.push(...e.failed.map((f) => `email-index: ${f}`));
      } catch (err) {
        failed.push(`email-index: ${err instanceof Error ? err.message : String(err)}`);
      }
      await setSetting("billing.dailyRanOn", today, "tick");
      daily = { reconciled: reconciled.read, failed, usage: usage.length, revenue };
    }
    // After the daily block, so its decision is the same one, and the gateways' day is read back first.
    // runPartnerChores never throws; null means another run holds its lease.
    const partners = await runPartnerChores(now, { daily: daily !== null });
    // Fail-soft: a disk or settings problem with support files is reported, never allowed to stop the tick.
    let support: { swept: number; purged: number; stuck: number; error?: string };
    try {
      support = await runSupportRetention(now);
    } catch (err) {
      support = { swept: 0, purged: 0, stuck: 0, error: (redactSecrets(err instanceof Error ? err.message : String(err)) ?? "").slice(0, 300) || "failed" };
    }
    const result = {
      held: lifecycle.filter((o) => o.action === "held").map((o) => o.slug),
      lifted: lifecycle.filter((o) => o.action === "lifted").map((o) => o.slug),
      closed: lifecycle.filter((o) => o.action === "closed").map((o) => o.slug),
      reminded: lifecycle.filter((o) => o.reminded).map((o) => o.slug),
      daily,
      support,
      partners,
    };
    try {
      await recordTick(
        {
          ms: Date.now() - started,
          held: result.held,
          lifted: result.lifted,
          closed: result.closed,
          reminded: result.reminded.length,
          daily: daily && { reconciled: daily.reconciled, failed: daily.failed.length, usage: daily.usage, revenue: daily.revenue },
          partners,
        },
        "tick",
      );
    } catch (err) {
      // The summary is for people reading the console; the chores are done either way.
      console.error("[tick] could not record the summary", err);
    }
    return result;
  });
  if (!ran.ran) return NextResponse.json({ ok: true, skipped: "already-running" });
  return NextResponse.json({ ok: !ran.value.daily?.failed.length && !ran.value.support.error, ...ran.value });
}

export const GET = handle;
export const POST = handle;
