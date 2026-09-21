import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runScheduledBackup } from "@/lib/backup/scheduled";

/**
 * The scheduler's way in, for a deployment that already has a pinger.
 *
 * The same shape as `/api/marketing/tick`: hit it every few minutes, and the stored schedule
 * decides whether this knock is the one that takes a backup.
 *
 *   curl -H "Authorization: Bearer $BACKUP_TICK_SECRET" https://…/api/backup/tick
 *
 * ## Prefer the script where you can
 *
 * `npm run db:backup -- --if-due` does the same job without a secret to manage, and keeps working
 * when the web app is stopped — which matters, because the app being down is one of the situations
 * where you would most like the backups to have kept running. This route exists for hosted setups
 * where nothing can run a command on a schedule, only fetch a URL.
 *
 * ## Its own secret
 *
 * Not the marketing one. They authorise different things — one sends mail, the other produces a
 * complete copy of the database — and a single shared token means giving a mail pinger the ability
 * to spin up database dumps, which is a strange thing to have decided by accident.
 *
 * Without `BACKUP_TICK_SECRET` set, the endpoint refuses everything.
 */

export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const expected = process.env.BACKUP_TICK_SECRET?.trim();
  if (!expected) return false;

  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7).trim() : header.trim();
  if (!provided) return false;

  // Constant time, and the lengths compared first because timingSafeEqual throws on a mismatch —
  // and that throw would itself be the timing signal it exists to remove.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function handle(request: Request) {
  if (!authorised(request)) {
    // Terse, and identical whether the secret is missing or wrong.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const run = await runScheduledBackup();

    if (!run.ran) {
      return NextResponse.json({ ok: true, ran: false, reason: run.reason, nextRunAt: run.nextRunAt });
    }

    // A failed dump is reported as a failure here too. The scheduler watching this endpoint is the
    // only thing in a position to notice, and 200 OK on a failed backup is how it never does.
    if (!run.outcome.ok) {
      return NextResponse.json({ ok: false, ran: true, error: run.outcome.error }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      ran: true,
      reason: run.reason,
      filename: run.outcome.filename,
      sizeBytes: run.outcome.sizeBytes,
      pruned: run.outcome.pruned,
    });
  } catch (err) {
    console.error("backup tick failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "The tick failed." },
      { status: 500 },
    );
  }
}

/** GET so a plain scheduler can call it; POST so a webhook-style caller can too. */
export const GET = handle;
export const POST = handle;
