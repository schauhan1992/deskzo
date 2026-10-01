import { runMarketingTick } from "@/lib/marketing/tick";
import { refreshStaleLeadScores } from "@/lib/leads/score-store";
import { refreshStaleCreditRatings } from "@/lib/credit/load";
import { detectSalesWins } from "@/lib/wins/detect";
import { announceActivityAwards } from "@/lib/performance/announce";
import { announcePrizes } from "@/lib/wins/prize-announce";
import { runRevenueAndClose } from "@/lib/close/nightly";
import { runOrderReleases } from "@/lib/orders/handoff";
import { runCollectionsDaily } from "@/lib/collections/daily";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { TickResult } from "@/lib/marketing/tick";

/** What the tick reports for a workspace that has no campaigns to run. */
const NO_MARKETING: TickResult = { runId: "", enrolled: 0, stepped: 0, exited: 0, claimed: 0, sent: 0, failed: 0, tasks: 0, ms: 0 };

/**
 * Everything the app does on its five-minute heartbeat, for the workspace in hand — called by
 * /api/marketing/tick, once or for every workspace (src/lib/platform/fanout.ts).
 *
 * The marketing tick itself decides whether it succeeded; the rest ride along and are isolated, so
 * a scoring failure never reports the heartbeat as failed or stops it. Each part runs only where the
 * workspace has its module — in the plan and switched on; the wins announcements ask for themselves.
 */
export async function runHeartbeat() {
  // Links in the mail have to be absolute and work from outside: the workspace's own address.
  const origin = await tenantOrigin();
  // A plan without marketing sends nothing, even a campaign queued before the plan changed.
  const result = (await moduleAvailableForTenant("marketing")) ? await runMarketingTick(origin) : NO_MARKETING;
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
  const creditRatingsRefreshed = !(await moduleAvailableForTenant("receivables")) ? 0 : await refreshStaleCreditRatings({ limit: 500 }).catch((err) => {
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
  /**
   * Revenue & Close, once a day: the month-end checklist generated and checked, revenue recognised and
   * prepaids and accruals posted as the Automation account. Its own claim row decides who runs it; it
   * asks after its own module (and runs the postings without it while schedules are still running).
   */
  const revenueAndClose = await runRevenueAndClose().catch((err) => {
    console.error("revenue & close nightly failed", err);
    return { ran: false };
  });
  /**
   * Orders scheduled to go to purchase today, released once a day — its own claim row decides who runs
   * it. Purchase's screens release due orders as they load too, so this is the guarantee, not the only way.
   */
  const orderReleases = await runOrderReleases().catch((err) => {
    console.error("order release failed", err);
    return { ran: false, released: 0 };
  });
  /**
   * Collections, once a day: promises to pay resolved (kept, or broken once their day has passed), each
   * broken one told to whoever logged it and their manager, one summary to accounts, and that morning's
   * follow-up reminders where there is no task. Its own claim row decides who runs it.
   */
  const collections = await runCollectionsDaily().catch((err) => {
    console.error("collections daily failed", err);
    return { ran: false, broken: 0 };
  });
  return {
    ...result,
    leadScoresRefreshed,
    creditRatingsRefreshed,
    salesWinsCelebrated: salesWins.created,
    activityAwardAnnounced: activityAward.announced,
    prizesAnnounced: prizes.announced,
    revenueAndCloseRan: revenueAndClose.ran,
    ordersReleased: orderReleases.released,
    promisesBroken: collections.broken,
  };
}
