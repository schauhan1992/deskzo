"use client";

import { useState, useTransition } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { invoicePayLink } from "@/actions/payment-collection";
import type { PayLink } from "@/lib/collect/links";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useClock } from "@/components/time/clock-provider";
import { formatMoney } from "@/lib/currency";

/**
 * An invoice's pay-now link (owner, 23 Oct 2026 — src/lib/collect/links.ts): the open one, or a button that
 * makes one for its balance. Reminders and the portal hand out the same link.
 */
export function InvoicePayLink({ invoiceId, initial, gateway, mayMake }: { invoiceId: string; initial: PayLink | null; gateway: string; mayMake: boolean }) {
  const clock = useClock();
  const [link, setLink] = useState<PayLink | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  const make = () => {
    setError(null);
    startTransition(async () => {
      const result = await invoicePayLink(invoiceId);
      if (!result.ok) return setError(result.error);
      setLink(result.data);
    });
  };
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy it — select the link and copy it instead.");
    }
  };

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Pay online</CardHeader>
      <CardContent className="space-y-3 text-sm">
        {link ? (
          <>
            <p className="text-muted">
              A pay-now link for {formatMoney(link.amount, link.currency)} through {gateway}
              {link.expiresAt ? `, open until ${clock.date(link.expiresAt)}` : ""}. Paid, it&apos;s recorded against this invoice by itself.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 max-w-full truncate rounded-base border border-line bg-surface-sunken px-2 py-1 font-mono text-xs text-text">{link.url}</span>
              <Button type="button" variant="secondary" size="sm" onClick={copy}>
                <Copy className="size-4" aria-hidden="true" />
                {copied ? "Copied" : "Copy"}
              </Button>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
                Open <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted">No pay-now link yet. Reminders make one when they go; you can make it now to send yourself.</p>
            {mayMake && (
              <Button type="button" size="sm" onClick={make} disabled={pending}>
                {pending ? "Making it…" : "Make a pay-now link"}
              </Button>
            )}
          </div>
        )}
        {error && <p role="alert" className="text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
