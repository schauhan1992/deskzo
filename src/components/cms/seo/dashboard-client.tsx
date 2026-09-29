"use client";

import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { cmsSeoRecalculate, cmsSeoRecalculateBatch } from "@/actions/cms/seo";
import { useCmsAction } from "@/components/cms/common/use-cms-action";
import { Button } from "@/components/ui/button";
import { SidePane } from "@/components/ui/side-pane";
import type { SeoEntityType, SeoScoreRow } from "@/lib/cms/types";

/**
 * The SEO Intelligence dashboard's moving parts: "Recalculate all" (the stale and never-scored, a
 * batch at a time, with its progress, and a way to stop), "Recalculate everything" (every entity,
 * for changes the stale rules can't see), recalculating one entity, and the detail drawer — which
 * the address opens (`?open=post:<id>`) and closing takes off the address again.
 */

const noSubscribe = () => () => {};

type Run = { all: boolean; processed: number; failed: number; total: number; state: "running" | "done" | "cancelled" | "failed"; error: string | null };

/**
 * Loops `cmsSeoRecalculateBatch` with its cursor until the store says it is done — never one giant
 * request — showing "Scored 50 of 120", and stops after the batch in flight when cancelled. The page
 * is refreshed at the end, so the cards and the table show the new numbers.
 */
export function RecalculateControls({ stale, uncalculated, entities }: { stale: number; uncalculated: number; entities: number }) {
  const router = useRouter();
  const [run, setRun] = useState<Run | null>(null);
  const cancelled = useRef(false);
  const behind = stale + uncalculated;
  const running = run?.state === "running";

  async function start(all: boolean) {
    if (running) return;
    cancelled.current = false;
    let cursor: string | null = null;
    let processed = 0;
    let failed = 0;
    let total = all ? entities : behind;
    setRun({ all, processed, failed, total, state: "running", error: null });
    for (let batch = 0; batch < 2000; batch++) {
      let result: Awaited<ReturnType<typeof cmsSeoRecalculateBatch>>;
      try {
        result = await cmsSeoRecalculateBatch(cursor, { all });
      } catch {
        setRun({ all, processed, failed, total, state: "failed", error: "The recalculation stopped — the network or the server didn't answer. What was scored is kept; start again to finish." });
        break;
      }
      if (!result.ok) {
        setRun({ all, processed, failed, total, state: "failed", error: result.error });
        break;
      }
      processed += result.data.processed;
      failed += result.data.failed;
      total = processed + failed + result.data.remaining;
      cursor = result.data.cursor;
      if (result.data.done) {
        setRun({ all, processed, failed, total, state: "done", error: null });
        break;
      }
      if (cancelled.current) {
        setRun({ all, processed, failed, total, state: "cancelled", error: null });
        break;
      }
      setRun({ all, processed, failed, total, state: "running", error: null });
    }
    router.refresh();
  }

  const percent = run && run.total > 0 ? Math.min(100, Math.round(((run.processed + run.failed) / run.total) * 100)) : run?.state === "done" ? 100 : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {behind > 0 && (
          <Button type="button" size="sm" onClick={() => void start(false)} disabled={running}>
            {running && !run?.all ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
            Recalculate all
          </Button>
        )}
        <Button type="button" size="sm" variant="secondary" onClick={() => void start(true)} disabled={running} title="Every page, post and archive, whether it looks out of date or not — after a change the stale rules can't see (an image's alt text, a redirect, the trial length)">
          {running && run?.all ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
          Recalculate everything
        </Button>
        {running && (
          <Button type="button" size="sm" variant="ghost" onClick={() => {
              cancelled.current = true;
            }}>
            Cancel
          </Button>
        )}
      </div>
      {run && (
        <div className="space-y-1.5" aria-live="polite">
          <div
            role="progressbar"
            aria-label={run.all ? "Recalculating everything" : "Recalculating the out-of-date scores"}
            aria-valuemin={0}
            aria-valuemax={Math.max(run.total, 1)}
            aria-valuenow={Math.min(run.processed + run.failed, Math.max(run.total, 1))}
            aria-valuetext={`Scored ${run.processed} of ${run.total}`}
            className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken"
          >
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted">
            {`Scored ${run.processed.toLocaleString("en-IN")} of ${run.total.toLocaleString("en-IN")}`}
            {run.failed > 0 ? ` · ${run.failed.toLocaleString("en-IN")} couldn't be scored (left as they were)` : ""}
            {run.state === "running" ? "…" : run.state === "done" ? " — done." : run.state === "cancelled" ? " — stopped. What was scored is kept." : ""}
          </p>
          {run.error && (
            <p role="alert" className="text-xs text-danger">
              {run.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** "Recalculate" for one entity (writers): the cache is refreshed and the page with it. */
export function RecalculateOneButton({ type, entityKey, label = "Recalculate" }: { type: SeoEntityType; entityKey: string; label?: string }) {
  const action = useCmsAction<SeoScoreRow>();
  return (
    <span className="inline-flex flex-col gap-1">
      <Button type="button" size="sm" variant="secondary" disabled={action.pending} onClick={() => action.run(() => cmsSeoRecalculate(type, entityKey), { success: (row) => `Recalculated “${row.title}”: ${row.overall} (${row.label}).` })}>
        {action.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
        {label}
      </Button>
      {action.error && (
        <span role="alert" className="text-xs text-danger">
          {action.error}
        </span>
      )}
    </span>
  );
}

/**
 * One entity's analysis in a side drawer. Open while the address says so; closing it takes `open`
 * off the address (the filters and the page stay). Drawn only in the browser: the drawer is
 * portalled into the page's body, which a server render has none of.
 */
export function SeoDetailDrawer({ title, closeHref, children }: { title: string; closeHref: string; children: ReactNode }) {
  const router = useRouter();
  const inBrowser = useSyncExternalStore(noSubscribe, () => true, () => false);
  if (!inBrowser) return null;
  return (
    <SidePane open title={title} onClose={() => router.replace(closeHref, { scroll: false })}>
      {children}
    </SidePane>
  );
}
