"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useConsoleNotice } from "@/components/console/kit/notice";
import type { CmsConflict, CmsIssue, CmsResult } from "@/lib/cms/types";

type RunOptions<T> = {
  /** The page notice on success ("Settings published."); an empty string says nothing. */
  success?: string | ((data: T) => string);
  /** Re-render the page from the server afterwards so the change shows. Default true. */
  refresh?: boolean;
  onDone?: (data: T) => void;
  /** Called with a refusal, after it is stored — to move focus to the first field with an issue. */
  onRefused?: (refusal: { error: string; issues: CmsIssue[]; conflict: CmsConflict | null }) => void;
};

/** Said when an action throws rather than refusing — never the thrown text, which may carry internals. */
export const CMS_UNEXPECTED = "Something went wrong — nothing may have changed. Try again, or reload the page.";

/** Next's own control-flow errors (a redirect from inside an action) must reach the router, not be reported. */
function isNextSignal(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * One CMS mutation (src/actions/cms/*): run in a transition, its refusal kept for the form or dialog
 * that asked — with the field `issues` and the save `conflict` a `CmsResult` can carry, which the
 * console's `useConsoleAction` has no room for — its success said once in the page notice, then a
 * refresh so the server's copy shows.
 *
 * A second `run` while one is in flight is ignored: a double click lands both clicks before the
 * button can say it is busy, and "Publish" twice is two publishes in the activity log.
 */
export function useCmsAction<T>(): {
  pending: boolean;
  error: string | null;
  issues: CmsIssue[];
  conflict: CmsConflict | null;
  run(work: () => Promise<CmsResult<T>>, opts?: RunOptions<T>): void;
  reset(): void;
} {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<CmsIssue[]>([]);
  const [conflict, setConflict] = useState<CmsConflict | null>(null);
  const inFlight = useRef(false);

  const reset = useCallback(() => {
    setError(null);
    setIssues([]);
    setConflict(null);
  }, []);

  const run = useCallback(
    (work: () => Promise<CmsResult<T>>, opts?: RunOptions<T>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      reset();
      startTransition(async () => {
        try {
          let result: CmsResult<T> | undefined;
          try {
            result = await work();
          } catch (err) {
            if (isNextSignal(err)) throw err;
            setError(CMS_UNEXPECTED);
            return;
          }
          if (!result || typeof result !== "object") {
            setError(CMS_UNEXPECTED);
            return;
          }
          if (!result.ok) {
            const refusal = { error: result.error || CMS_UNEXPECTED, issues: result.issues ?? [], conflict: result.conflict ?? null };
            setError(refusal.error);
            setIssues(refusal.issues);
            setConflict(refusal.conflict);
            opts?.onRefused?.(refusal);
            return;
          }
          const data = result.data;
          const message = typeof opts?.success === "function" ? opts.success(data) : opts?.success;
          if (message) show("success", message);
          if (opts?.refresh !== false) router.refresh();
          opts?.onDone?.(data);
        } finally {
          inFlight.current = false;
        }
      });
    },
    [reset, router, show],
  );

  return { pending, error, issues, conflict, run, reset };
}

/** Issues keyed by their path ("nav[2].href"), the first message for each — what a field looks up. */
export function issuesByPath(issues: readonly CmsIssue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of issues) if (!(issue.path in out)) out[issue.path] = issue.message;
  return out;
}
