"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { consoleDeprovision, consoleEnterAsSupport, consoleSuspend } from "@/actions/platform/console";

/** A workspace's controls on its console page that need more than a click: a reason, a typed name, a link. */

export function SuspendForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const r = await consoleSuspend(tenantId, reason);
          if (r.ok) router.refresh();
          else setError(r.error);
        });
      }}
    >
      <Input className="h-8 w-64" placeholder="Why (kept in the audit log)" required value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for holding it" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !reason.trim()}>
        {pending ? "Holding…" : "Hold workspace"}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </form>
  );
}

export function DeprovisionForm({ tenantId, slug }: { tenantId: string; slug: string }) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        startTransition(async () => {
          const r = await consoleDeprovision(tenantId, typed);
          if (!r.ok) return setMessage({ ok: false, text: r.error });
          setMessage({ ok: true, text: r.data.backup ? `Closed. Final backup: ${r.data.backup}` : "Closed." });
          router.refresh();
        });
      }}
    >
      <p className="text-xs text-muted">
        A final full backup is taken, then its database is dropped and its addresses let go. Its keys are kept for 90 days, so the backup can still
        be read; after that nothing of it can be. Type <span className="font-mono text-text">{slug}</span> to confirm.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input className="h-8 w-48" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type the workspace address to confirm" autoComplete="off" />
        <Button type="submit" size="sm" variant="danger" disabled={pending || typed.trim() !== slug}>
          {pending ? "Closing…" : "Close workspace"}
        </Button>
      </div>
      {message && <p className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</p>}
    </form>
  );
}

/**
 * Going in as support. The pass is good for a minute and once, so it is shown as a link to open —
 * a new tab opened after the wait would be stopped by the browser as a pop-up.
 */
export function EnterAsSupport({ tenantId }: { tenantId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (url) {
    return (
      <OutboundLink href={url} className="text-sm font-medium text-brand hover:underline" onClick={() => setTimeout(() => setUrl(null), 0)}>
        Open the workspace as support (within a minute)
      </OutboundLink>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const r = await consoleEnterAsSupport(tenantId);
            if (r.ok) setUrl(r.data.url);
            else setError(r.error);
          });
        }}
      >
        {pending ? "Preparing…" : "Enter as support"}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </span>
  );
}
