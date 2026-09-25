import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runMarketingTick } from "@/lib/marketing/tick";
import { refreshStaleLeadScores } from "@/lib/leads/score-store";
import { refreshStaleCreditRatings } from "@/lib/credit/load";
import { detectSalesWins } from "@/lib/wins/detect";
import { announceActivityAwards } from "@/lib/performance/announce";
import { announcePrizes } from "@/lib/wins/prize-announce";
import { tenantOrigin } from "@/lib/tenancy/resolve";

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

  // Links in the mail have to be absolute and have to work from outside, so the origin comes from
  // the request rather than an env var nobody would remember to set.
  const origin = await tenantOrigin();

  try {
    const result = await runMarketingTick(origin);
    /**
     * Lead scores, riding on the app's one heartbeat.
     *
     * Part of a score is time — a lead nobody has touched gets colder by the day with nothing
     * about it changing — so scores not refreshed in 12 hours are recomputed here, 500 at a time.
     * Isolated: a scoring failure must not report the marketing tick as failed, or stop it.
     */
    const leadScoresRefreshed = await refreshStaleLeadScores({ limit: 500 }).catch((err) => {
      console.error("lead score refresh failed", err);
      return 0;
    });
    /**
     * Credit ratings, for the same reason: an invoice passing its due date changes a rating with
     * nothing being written. Only the stored copy the Customer credit list sorts by — decisions always
     * recompute — so a failure here costs freshness, never a wrong approval.
     */
    const creditRatingsRefreshed = await refreshStaleCreditRatings({ limit: 500 }).catch((err) => {
      console.error("credit rating refresh failed", err);
      return 0;
    });
    /**
     * Sales wins: a target crossed by an invoice paid overnight, the month's top performer on the
     * 1st. Deals and first orders are caught the moment they happen too; this catches the rest.
     */
    const salesWins = await detectSalesWins().catch((err) => {
      console.error("sales wins detection failed", err);
      return { created: 0 };
    });
    /** The fortnight's most active people, the morning after it closes. Once — the award row is the claim. */
    const activityAward = await announceActivityAwards().catch((err) => {
      console.error("activity awards failed", err);
      return { announced: null };
    });
    /** What is up for grabs, as a month or fortnight opens. Once each — the announcement row is the claim. */
    const prizes = await announcePrizes().catch((err) => {
      console.error("prize announcements failed", err);
      return { announced: [] as string[] };
    });
    return NextResponse.json({
      ok: true,
      ...result,
      leadScoresRefreshed,
      creditRatingsRefreshed,
      salesWinsCelebrated: salesWins.created,
      activityAwardAnnounced: activityAward.announced,
      prizesAnnounced: prizes.announced,
    });
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
