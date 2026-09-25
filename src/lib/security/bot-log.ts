import { db } from "@/lib/db";
import type { BotVerdict } from "@/lib/security/bots";
import { tenantKey } from "@/lib/tenancy/cache";
import { throttle } from "@/lib/security/throttle";

/**
 * Recording a crawler, without handing it a way to fill the disk.
 *
 * A blocked request is cheap for the crawler and expensive for us: one connection for them, one
 * row for us. A crawler that ignores the 403 and keeps going would turn this log into a denial of
 * service against our own database, and the row that mattered would be somewhere in the middle of
 * it. So the first sighting of a given address and agent is written and the rest of the window is
 * folded into the next one — see src/lib/security/throttle.ts.
 *
 * The result reads "Googlebot, 1,284 more since the last entry" rather than repeating itself 1,284
 * times, which is also the more useful sentence.
 */

const WINDOW_MS = 10 * 60_000;

export async function recordBotHit(input: {
  verdict: NonNullable<BotVerdict>;
  path: string;
  ipAddress: string | null;
  blocked: boolean;
}) {
  // Keyed on the category, not the agent string: the agent is whatever the caller sent, so it
  // was a throttle the thing being throttled got to defeat by varying one header. The category is
  // a closed set of six, and the full agent is still written into the row itself.
  const key = `bot:${input.ipAddress ?? "?"}|${input.verdict.category}`;
  const { write, suppressedSince } = throttle(`${await tenantKey()}|${key}`, WINDOW_MS);
  if (!write) return;

  try {
    const kind = input.verdict.category.toLowerCase().replaceAll("_", " ");
    const repeats =
      suppressedSince > 0 ? ` (${suppressedSince.toLocaleString("en-IN")} more since the last entry)` : "";

    await db.activityLog.create({
      data: {
        kind: "BOT_BLOCKED",
        severity: "NOTICE",
        summary: input.blocked
          ? `Blocked ${kind} at ${input.path}${repeats}`
          : `Allowed ${kind} at ${input.path} — policy is log-only${repeats}`,
        path: input.path,
        ipAddress: input.ipAddress,
        userAgent: input.verdict.agent,
        metadata: { category: input.verdict.category, blocked: input.blocked, repeatsFolded: suppressedSince },
      },
    });
  } catch (err) {
    // Never the reason a request fails. A crawler being logged badly is not worth a 500 served to
    // a real user who happens to sit behind the same address.
    console.error("recordBotHit failed", err);
  }
}
