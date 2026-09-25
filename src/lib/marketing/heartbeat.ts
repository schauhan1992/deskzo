import { runMarketingTick } from "@/lib/marketing/tick";
import { refreshStaleLeadScores } from "@/lib/leads/score-store";
import { refreshStaleCreditRatings } from "@/lib/credit/load";
import { detectSalesWins } from "@/lib/wins/detect";
import { announceActivityAwards } from "@/lib/performance/announce";
import { announcePrizes } from "@/lib/wins/prize-announce";
import { tenantOrigin } from "@/lib/tenancy/resolve";

/**
 * Everything the app does on its five-minute heartbeat, for the workspace in hand — called by
 * /api/marketing/tick, once or for every workspace (src/lib/platform/fanout.ts).
 *
 * The marketing tick itself decides whether it succeeded; the rest ride along and are isolated, so
 * a scoring failure never reports the heartbeat as failed or stops it.
 */
export async function runHeartbeat() {
  // Links in the mail have to be absolute and work from outside: the workspace's own address.
  const origin = await tenantOrigin();
  const result = await runMarketingTick(origin);
  /**
   * Lead scores. Part of a score is time — a lead nobody has touched gets colder by the day with
   * nothing about it changing — so scores not refreshed in 12 hours are recomputed, 500 at a time.
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
  return {
    ...result,
    leadScoresRefreshed,
    creditRatingsRefreshed,
    salesWinsCelebrated: salesWins.created,
    activityAwardAnnounced: activityAward.announced,
    prizesAnnounced: prizes.announced,
  };
}
