"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { replyToTicketByEmail } from "@/actions/support-mail";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Answering the customer from the ticket: an email to whoever wrote last (else the ticket's contact),
 * from the company's name, threaded so their answer comes back here (src/lib/support-mail/send.ts). Your
 * name is added under it. Internal notes stay in Comments; this goes to the customer.
 */
export function TicketEmailReply({ ticketId, to, canReply }: { ticketId: string; to: string | null; canReply: boolean }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [cc, setCc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!canReply) return <p className="text-xs text-subtle">Replying by email becomes available once support email is switched on for this platform.</p>;
  if (!to) return <p className="text-xs text-subtle">Add an email address to the ticket&apos;s contact to reply by email.</p>;

  function send() {
    setError(null);
    setSent(false);
    startTransition(async () => {
      const result = await replyToTicketByEmail({
        ticketId,
        body,
        cc: cc
          .split(/[,;\s]+/)
          .map((a) => a.trim())
          .filter(Boolean),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setBody("");
      setCc("");
      setSent(true);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 border-t border-line pt-3">
      <Label htmlFor={`reply-${ticketId}`}>Reply to {to}</Label>
      <Textarea
        id={`reply-${ticketId}`}
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="This goes to the customer by email. For a note only your team sees, use Comments."
      />
      <Input aria-label="Cc" placeholder="Cc (optional) — separate addresses with commas" value={cc} onChange={(e) => setCc(e.target.value)} />
      <div aria-live="polite">
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        {!error && sent && <ActionNotice tone="success">Sent. Their answer will appear here.</ActionNotice>}
      </div>
      <Button type="button" size="sm" onClick={send} disabled={!body.trim() || pending}>
        {pending ? "Sending…" : "Send reply"}
      </Button>
    </div>
  );
}
