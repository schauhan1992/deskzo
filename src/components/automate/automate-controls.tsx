"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  cancelAutomationRun,
  createBlankWorkflow,
  retryAutomationRun,
  retryFailedAutomationRuns,
  runAutomationWorkflowNow,
  setAutomationPaused,
  setAutomationWorkflowStatus,
} from "@/actions/automate";
import type { ActionResult } from "@/actions/company";

/**
 * The buttons on Automate's pages (Phase 1): switch a workflow on or pause it, run one now, cancel or
 * retry a run, and the workspace's kill switch. Each calls its server action, shows a refusal where
 * it was pressed, and refreshes the page.
 */

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (work: () => Promise<ActionResult<unknown>>) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  return { pending, error, act };
}

function Refusal({ error }: { error: string | null }) {
  return error ? <p className="mt-1 text-xs text-danger">{error}</p> : null;
}

export function WorkflowControls({ id, status, trigger, published }: { id: string; status: string; trigger: string | null; published: boolean }) {
  const { pending, error, act } = useAct();
  return (
    <div>
      <div className="flex flex-wrap justify-end gap-1.5">
        {status === "ACTIVE" && trigger === "manual" && (
          <Button size="sm" variant="subtle" disabled={pending} onClick={() => act(() => runAutomationWorkflowNow(id))}>
            Run now
          </Button>
        )}
        {status === "ACTIVE" && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => setAutomationWorkflowStatus(id, "PAUSED"))}>
            Pause
          </Button>
        )}
        {status !== "ACTIVE" && published && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => setAutomationWorkflowStatus(id, "ACTIVE"))}>
            Switch on
          </Button>
        )}
      </div>
      <Refusal error={error} />
    </div>
  );
}

export function RunControls({ id, status }: { id: string; status: string }) {
  const { pending, error, act } = useAct();
  const cancellable = ["QUEUED", "WAITING", "RUNNING", "NEEDS_ATTENTION"].includes(status);
  const retryable = status === "FAILED" || status === "NEEDS_ATTENTION";
  if (!cancellable && !retryable) return null;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {retryable && (
          <Button size="sm" disabled={pending} onClick={() => act(() => retryAutomationRun(id))}>
            {status === "NEEDS_ATTENTION" ? "Try the step again" : "Retry from the failed step"}
          </Button>
        )}
        {cancellable && (
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => cancelAutomationRun(id))}>
            Cancel run
          </Button>
        )}
      </div>
      <Refusal error={error} />
    </div>
  );
}

/** Automate › Runs, filtered to the failed ones: every one tried again from its failed step, once the cause is fixed. */
export function RetryFailedButton({ workflowId, count }: { workflowId: string | null; count: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  if (count === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() => {
          if (!window.confirm(`Try ${count === 1 ? "this failed run" : "these failed runs"} again from the step that failed? Fix what made them fail first.`)) return;
          start(async () => {
            const result = await retryFailedAutomationRuns(workflowId);
            if (!result.ok) return setSaid({ ok: false, text: result.error });
            setSaid({ ok: true, text: `${result.data.retried} tried again${result.data.left ? `; ${result.data.left} more — retry again for those` : ""}.` });
            router.refresh();
          });
        }}
      >
        {pending ? "Retrying…" : "Retry failed runs"}
      </Button>
      {said && <span className={`text-xs ${said.ok ? "text-success" : "text-danger"}`}>{said.text}</span>}
    </div>
  );
}

/**
 * A run as plain text for a support ticket (the runbook): which run, how it went, and each step — its
 * status, time and error — never what went in or came out.
 */
export function CopyForSupport({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? "Copied" : "Copy for a support ticket"}
    </Button>
  );
}

/** A new, empty workflow, opened in the builder. */
export function NewWorkflowButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const made = await createBlankWorkflow();
            if (made.ok) router.push(made.data.path);
            else setError(made.error);
          })
        }
      >
        New workflow
      </Button>
      <Refusal error={error} />
    </div>
  );
}

export function WorkspacePauseSwitch({ paused }: { paused: boolean }) {
  const { pending, error, act } = useAct();
  return (
    <div className="text-right">
      <Button size="sm" variant={paused ? "primary" : "secondary"} disabled={pending} onClick={() => act(() => setAutomationPaused(!paused))}>
        {paused ? "Let workflows run again" : "Pause every workflow"}
      </Button>
      <Refusal error={error} />
    </div>
  );
}
