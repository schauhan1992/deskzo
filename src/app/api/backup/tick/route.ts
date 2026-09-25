import { NextResponse } from "next/server";
import { runScheduledBackup } from "@/lib/backup/scheduled";
import { forEachTenant, tickTargets } from "@/lib/platform/fanout";
import { fanoutResponse, tickAuthorised } from "@/lib/platform/tick-auth";

/**
 * The scheduler's way in, for a deployment that already has a pinger.
 *
 * The same shape as `/api/marketing/tick`: hit it every few minutes, and each workspace's stored
 * schedule decides whether this knock is the one that takes its backup.
 *
 *   curl -H "Authorization: Bearer $BACKUP_TICK_SECRET" https://acme.example.com/api/backup/tick
 *   curl -H "Authorization: Bearer $BACKUP_TICK_SECRET" https://admin.example.com/api/backup/tick
 *
 * On a workspace's own address, that workspace; on the platform's address, every active workspace,
 * two at a time — a dump is heavy — each into its own folder (src/lib/platform/fanout.ts).
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
 * complete copy of a database — and a single shared token means giving a mail pinger the ability
 * to spin up database dumps, which is a strange thing to have decided by accident.
 *
 * Without `BACKUP_TICK_SECRET` set, the endpoint refuses everything.
 */

export const dynamic = "force-dynamic";

/** Long, because a large database takes a while to dump; the lease is held for twice this. */
const BACKUP_TIMEOUT_MS = 45 * 60_000;

async function handle(request: Request) {
  if (!tickAuthorised(request, "BACKUP_TICK_SECRET")) {
    // Terse, and identical whether the secret is missing or wrong.
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const { scope, tenants } = await tickTargets(request.headers);
  const outcomes = await forEachTenant(
    "backup-tick",
    tenants,
    async () => {
      const run = await runScheduledBackup();
      // A failed dump is a failure of this workspace's run, so the fan-out reports it as one.
      if (run.ran && !run.outcome.ok) throw new Error(run.outcome.error);
      return run;
    },
    { concurrency: 2, timeoutMs: BACKUP_TIMEOUT_MS },
  );

  if (scope === "platform") {
    return fanoutResponse(outcomes, (run) =>
      run.ran && run.outcome.ok ? { ran: true, filename: run.outcome.filename, sizeBytes: run.outcome.sizeBytes } : { ran: false, reason: run.reason },
    );
  }

  const only = outcomes[0];
  if (!only) return NextResponse.json({ ok: false, error: "No workspace here." }, { status: 404 });
  if ("skipped" in only) return NextResponse.json({ ok: true, ran: false, reason: "already-running" });
  // A failed dump is reported as a failure here too. The scheduler watching this endpoint is the
  // only thing in a position to notice, and 200 OK on a failed backup is how it never does.
  if (!only.ok) return NextResponse.json({ ok: false, ran: true, error: only.error }, { status: 500 });
  const run = only.value;
  if (!run.ran) return NextResponse.json({ ok: true, ran: false, reason: run.reason, nextRunAt: run.nextRunAt });
  if (!run.outcome.ok) return NextResponse.json({ ok: false, ran: true, error: run.outcome.error }, { status: 500 });
  return NextResponse.json({
    ok: true,
    ran: true,
    reason: run.reason,
    filename: run.outcome.filename,
    sizeBytes: run.outcome.sizeBytes,
    pruned: run.outcome.pruned,
  });
}

/** GET so a plain scheduler can call it; POST so a webhook-style caller can too. */
export const GET = handle;
export const POST = handle;
