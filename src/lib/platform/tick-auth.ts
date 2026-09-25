import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type { JobOutcome } from "@/lib/platform/fanout";

/**
 * The two things every scheduled tick route shares.
 *
 * `tickAuthorised`: the scheduler's shared secret, from the environment, as a bearer token. Without
 * the secret set the endpoint refuses everything — an open endpoint that sends mail or takes backups
 * is worse than a scheduler that never runs. The secret is the platform operator's, not any
 * workspace's: it is what a cron job on the server carries, whichever address it calls.
 *
 * `fanoutResponse`: what a tick called on the platform's own address answers — every workspace's
 * outcome, and a 500 when any of them failed, because the scheduler watching the endpoint is the one
 * thing in a position to notice.
 */
export function tickAuthorised(request: Request, secretName: "MARKETING_TICK_SECRET" | "BACKUP_TICK_SECRET"): boolean {
  const expected = process.env[secretName]?.trim();
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!provided) return false;
  // Constant time; the lengths first, because timingSafeEqual throws on a mismatch — and that throw
  // would itself be the timing signal it exists to remove.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function fanoutResponse<T>(outcomes: JobOutcome<T>[], summarise: (value: T) => Record<string, unknown> = (v) => ({ ...(v as object) })) {
  const failed = outcomes.filter((o) => "ok" in o && !o.ok).length;
  return NextResponse.json(
    {
      ok: failed === 0,
      scope: "platform",
      workspaces: outcomes.length,
      failed,
      results: outcomes.map((o) =>
        "skipped" in o
          ? { workspace: o.slug, skipped: o.skipped }
          : o.ok
            ? { workspace: o.slug, ok: true, ms: o.ms, ...summarise(o.value) }
            : { workspace: o.slug, ok: false, ms: o.ms, error: o.error },
      ),
    },
    { status: failed ? 500 : 200 },
  );
}
