"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ConsoleResult } from "@/actions/platform/console";
import { useConsoleNotice } from "./notice";

type RunOptions<T> = {
  /** The page notice on success ("Workspace reopened."); an empty string says nothing. */
  success?: string | ((data: T) => string);
  /** Re-render the page from the server afterwards so the change shows. Default true. */
  refresh?: boolean;
  onDone?: (data: T) => void;
};

/** Said when an action throws rather than refusing — never the thrown message, which may carry internals. */
const UNEXPECTED = "Something went wrong — nothing may have changed. Try again, or reload the page.";

/**
 * Next's own control-flow errors (a redirect or notFound from inside an action) carry a digest
 * starting "NEXT_" and must reach the router, not be reported as a failure.
 */
function isNextSignal(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("digest" in err)) return false;
  const digest = (err as { digest?: unknown }).digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

/**
 * One console mutation: a bound server action run in a transition, its refusal kept for the dialog
 * that asked, its success said once in the page notice and followed by a refresh.
 *
 * A second `run` while one is in flight is ignored. The button is disabled while pending, but a
 * double click lands both clicks before that render — and "Extend trial +14" twice is 28 days.
 */
export function useConsoleAction<T>(): {
  pending: boolean;
  error: string | null;
  run(work: () => Promise<ConsoleResult<T>>, opts?: RunOptions<T>): void;
  reset(): void;
} {
  const router = useRouter();
  const { show } = useConsoleNotice();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(
    (work: () => Promise<ConsoleResult<T>>, opts?: RunOptions<T>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setError(null);
      startTransition(async () => {
        try {
          let result: ConsoleResult<T> | undefined;
          try {
            result = await work();
          } catch (err) {
            if (isNextSignal(err)) throw err;
            setError(UNEXPECTED);
            return;
          }
          if (!result || typeof result !== "object") {
            setError(UNEXPECTED);
            return;
          }
          if (!result.ok) {
            setError(result.error || UNEXPECTED);
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
    [router, show],
  );

  const reset = useCallback(() => setError(null), []);

  return { pending, error, run, reset };
}
