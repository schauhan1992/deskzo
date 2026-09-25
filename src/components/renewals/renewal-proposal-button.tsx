"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText, Loader2 } from "lucide-react";
import { createProposalFromRenewal } from "@/actions/renewal-proposal";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";

/**
 * The renewal quote, in one click.
 *
 * No form, because there is nothing to ask: the customer, the site, the product, the seats including
 * any added mid-term, the full-term price and the next term are all on the record already, and the
 * action works the figures out from them. Putting a dialog in front of it would only offer somebody
 * the chance to retype numbers that are already right.
 *
 * What it produces is a draft, so the reading-over happens on the document itself — which is where
 * the numbers are laid out properly anyway, and where they can be corrected.
 */
export function RenewalProposalButton({
  companyProductId,
  companyName,
  alreadyRenewed,
}: {
  companyProductId: string;
  companyName: string;
  /** Quoting a renewal that has already been punched would bill the same term twice. */
  alreadyRenewed?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<
    { ok: true; id: string; docNumber: string | null; total: number } | { ok: false; error: string } | null
  >(null);

  if (alreadyRenewed) return null;

  return (
    <>
      <button
        type="button"
        disabled={pending}
        title={`Draft a renewal proposal for ${companyName}`}
        aria-label={`Draft a renewal proposal for ${companyName}`}
        onClick={() =>
          startTransition(async () => {
            const created = await createProposalFromRenewal({ companyProductId });
            setResult(
              created.ok
                ? { ok: true, id: created.data.id, docNumber: created.data.docNumber, total: created.data.total }
                : { ok: false, error: created.error },
            );
            // The Stage column reads the document this just wrote, so the row needs to re-render
            // whichever way it went.
            if (created.ok) router.refresh();
          })
        }
        className="rounded p-1 text-subtle hover:bg-surface-sunken hover:text-brand disabled:opacity-50"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
      </button>

      <Dialog
        open={result !== null}
        onClose={() => setResult(null)}
        title={result?.ok ? "Proposal drafted" : "Couldn't draft the proposal"}
      >
        {result?.ok ? (
          <div className="space-y-4">
            <p className="text-sm text-text">
              <span className="font-mono">{result.docNumber}</span> for {companyName}
              {result.total > 0 && <> — {formatCurrency(result.total)}</>}.
            </p>
            <p className="text-xs text-muted">
              It is a draft: nothing has gone to the customer and the number is not final. The seats include anything
              added mid-term, and the price is the full-term one rather than what a part-term addition was charged.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => router.push(`/documents/${result.id}`)}>Open it</Button>
              <Button variant="secondary" onClick={() => setResult(null)}>
                Stay here
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-danger">{result?.ok === false ? result.error : ""}</p>
            <Button variant="secondary" onClick={() => setResult(null)}>
              Close
            </Button>
          </div>
        )}
      </Dialog>
    </>
  );
}
