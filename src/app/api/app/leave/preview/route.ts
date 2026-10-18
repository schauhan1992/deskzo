import { appRoute } from "@/lib/app/handler";
import { needAppModule } from "@/lib/app/daily";
import { ApiError } from "@/lib/api/handler";
import { previewLeaveDays } from "@/actions/leave";

/** How many days of leave a span takes, weekends and holidays left out — before asking (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const POST = appRoute({}, async ({ actor, body }) => {
  await needAppModule("hr", actor.userId);
  const input = await body();
  if (typeof input.from !== "string" || typeof input.to !== "string" || !DAY.test(input.from) || !DAY.test(input.to)) throw new ApiError(400, "invalid_request", "Dates are yyyy-mm-dd.");
  const preview = await previewLeaveDays({ fromDate: input.from, toDate: input.to, fromHalfDay: input.from_half_day === true, toHalfDay: input.to_half_day === true });
  return { data: { days: preview.days, skipped: preview.skipped } };
});
