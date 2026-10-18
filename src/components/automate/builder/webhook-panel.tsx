"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { setWorkflowWebhookSigned, workflowWebhook } from "@/actions/automate";
import type { WebhookView } from "@/lib/automate/webhooks";

/**
 * A webhook-started workflow's address, on its trigger's form (Deskzo Automate, Phase 4): made when
 * asked for, copied into the outside app, its signing secret shown on request, and replaced when it
 * may have leaked — the old one stops at once. It takes calls once the workflow is published and on.
 */
export function WebhookPanel({ workflowId, initial, demo }: { workflowId: string; initial: WebhookView | null; demo: boolean }) {
  const [hook, setHook] = useState<WebhookView | null>(initial);
  const [showSecret, setShowSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const clock = useClock();

  const act =(work: () => Promise<{ ok: true; data: WebhookView | null } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const result = await work();
      if (result.ok) setHook(result.data);
      else setError(result.error);
    });

  if (!hook) {
    return (
      <div className="space-y-2 rounded-base border border-line p-3">
        <p className="text-sm text-muted">An outside app — a website, Zapier, Make, your own system — starts this workflow by sending data to its own address.</p>
        <Button type="button" size="sm" variant="secondary" disabled={demo || pending} onClick={() => act(() => workflowWebhook(workflowId))}>
          Make its address
        </Button>
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  // Its address and secret are its owner's (the builder is read-only for anybody else).
  if (!hook.address) {
    return (
      <div className="space-y-1 rounded-base border border-line p-3 text-sm text-muted">
        <p>It has an address an outside app calls. Only the workflow&apos;s owner sees it, and its signing secret.</p>
        <p className="text-xs">{hook.lastReceivedAt ? `Last called ${clock.dateTimeShort(hook.lastReceivedAt)}` : "Not called yet."}</p>
      </div>
    );
  }

  const example = `curl -X POST '${hook.address}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: order-1042' \\\n  -d '{"name": "Asha", "email": "asha@example.com"}'`;
  return (
    <div className="space-y-3 rounded-base border border-line p-3">
      <div className="space-y-1">
        <Label>Its address</Label>
        <div className="flex items-center gap-1">
          <Input readOnly value={hook.address} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(hook.address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-subtle">Send JSON or a form with POST. It answers at once; the workflow runs a moment later. Keep the address private — it is the key.</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={hook.requireSignature} disabled={demo || pending} onChange={(e) => act(() => setWorkflowWebhookSigned(workflowId, e.target.checked))} />
        Take only calls signed with its secret
      </label>
      <div className="space-y-1">
        <Label className="block">Signing secret</Label>
        {showSecret ? (
          <Input readOnly value={hook.secret} onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" />
        ) : (
          <button
            type="button"
            disabled={demo || pending}
            className="text-xs font-medium text-brand hover:underline disabled:opacity-50"
            onClick={() => {
              // Asked for when shown, never sent with the page.
              act(() => workflowWebhook(workflowId));
              setShowSecret(true);
            }}
          >
            Show the secret
          </button>
        )}
        <p className="text-xs text-subtle">
          To sign: X-Deskzo-Timestamp (seconds) and X-Deskzo-Signature — the hex HMAC-SHA256 of &ldquo;timestamp.body&rdquo; with this secret, within 5 minutes.
        </p>
      </div>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">An example call</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre rounded-base bg-surface-sunken p-2">{example}</pre>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>{hook.lastReceivedAt ? `Last called ${clock.dateTimeShort(hook.lastReceivedAt)}` : "Not called yet."}</span>
        <button
          type="button"
          disabled={demo || pending}
          className="font-medium text-danger hover:underline disabled:opacity-50"
          onClick={() => {
            if (window.confirm("Make a new address? The old one stops working at once.")) act(() => workflowWebhook(workflowId, true));
          }}
        >
          New address
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
