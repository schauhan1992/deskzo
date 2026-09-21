"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Play } from "lucide-react";
import type { tickHealth } from "@/lib/marketing/tick";
import { runTickNow } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

type Health = Awaited<ReturnType<typeof tickHealth>>;

/**
 * Whether the scheduler is actually running.
 *
 * The one thing about this module that fails completely silently. Everything looks fine — campaigns
 * scheduled, journeys active, no errors anywhere — and nothing is going out, because whatever was
 * meant to call the endpoint stopped. So the app says so rather than waiting to be asked.
 */
export function TickBanner({ health, canRun }: { health: Health; canRun: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: NoticeTone; message: string } | null>(null);

  const run = () => {
    setMessage(null);
    startTransition(async () => {
      const result = await runTickNow();
      /**
       * A refusal was rendered in success green.
       *
       * This is the control somebody reaches for when they suspect the scheduler has stopped — the
       * one moment they most need to be told it did not run. "The scheduler secret isn't set" in the
       * same green as "Ran: 40 sent" reads as confirmation that everything is fine.
       */
      setMessage(
        result.ok
          ? {
              tone: "success",
              message: `Ran: ${result.data.sent} sent, ${result.data.enrolled} enrolled, ${result.data.stepped} moved on.`,
            }
          : { tone: "error", message: result.error },
      );
      router.refresh();
    });
  };

  if (!health.stale) {
    return (
      <p className="text-xs text-subtle">
        Scheduler ran {health.minutesAgo === 0 ? "just now" : `${health.minutesAgo} min ago`}
        {health.waiting > 0 && ` · ${health.waiting} waiting to go out`}
        {canRun && (
          <>
            {" · "}
            <button type="button" className="underline hover:text-text" disabled={pending} onClick={run}>
              {pending ? "running…" : "run it now"}
            </button>
          </>
        )}
        {message && (
          <span role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "ml-2 text-danger" : "ml-2 text-success"}>
            {message.message}
          </span>
        )}
      </p>
    );
  }

  return (
    <Card className="border-warning/40 bg-warning-bg px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-warning">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">
              {health.lastRunAt
                ? `The scheduler hasn't run for ${health.minutesAgo} minutes.`
                : "The scheduler has never run."}
            </p>
            <p className="mt-0.5 text-xs">
              {health.waiting > 0
                ? `${health.waiting} message(s) are queued and waiting. `
                : "Nothing is queued yet, but nothing would go out if it were. "}
              Something outside the app has to call{" "}
              <span className="font-mono">/api/marketing/tick</span> every few minutes with the
              <span className="font-mono"> MARKETING_TICK_SECRET</span> as a bearer token.
            </p>
            {health.lastError && <p className="mt-1 text-xs">Last error: {health.lastError}</p>}
          </div>
        </div>
        {canRun && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={run}>
            <Play className="mr-1.5 h-3 w-3" />
            {pending ? "Running…" : "Run it now"}
          </Button>
        )}
      </div>
      <ActionNoticeRegion notice={message} className="mt-2" />
    </Card>
  );
}
