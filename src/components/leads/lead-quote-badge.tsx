import Link from "next/link";
import type { LeadStatus } from "@prisma/client";
import { FileText } from "lucide-react";
import { Badge } from "@/components/ui/card";
import { quoteBadge, type LeadQuote } from "@/lib/leads/quotes";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";

/** The hover text: which document, and how many went out. */
function describe(quote: LeadQuote | null): string {
  if (!quote) return "At Proposal sent or past it, with no quotation sent";
  const what = `${tradeDocumentLabels[quote.docType]} ${quote.docNumber}`;
  if (quote.status === "DRAFT") return `${what} — not issued yet`;
  return `${what}, dated ${formatCalendarDay(quote.issueDate)}${quote.sent > 1 ? ` — ${quote.sent} sent` : ""}`;
}

/**
 * A lead's quotation in the leads list (src/lib/leads/quotes.ts): the furthest one with its amount,
 * opening the document — or "No quote" on a deal that ought to have one by now, and a dash otherwise.
 */
export function LeadQuoteCell({ quote, status }: { quote: LeadQuote | null; status: LeadStatus }) {
  const badge = quoteBadge(quote, status);
  if (!badge) return <span className="text-subtle">—</span>;
  const body = (
    <span className="inline-flex items-center gap-1.5" title={describe(quote)}>
      <Badge tone={badge.tone}>{badge.label}</Badge>
      {quote && quote.status !== "DRAFT" && <span className="text-xs tabular-nums text-muted">{formatCurrency(quote.total, quote.currency)}</span>}
    </span>
  );
  return quote ? (
    <Link href={`/documents/${quote.id}`} className="hover:underline">
      {body}
    </Link>
  ) : (
    body
  );
}

/** The same on a board card, which is itself a link to the lead: a small chip, nothing to click. */
export function LeadQuoteChip({ quote, status }: { quote: LeadQuote | null; status: LeadStatus }) {
  const badge = quoteBadge(quote, status);
  if (!badge) return null;
  const tint: Record<typeof badge.tone, string> = {
    default: "bg-surface-sunken text-muted",
    blue: "bg-info-bg text-info",
    amber: "bg-warning-bg text-warning",
    brand: "bg-brand-subtle text-brand",
    green: "bg-success-bg text-success",
    red: "bg-danger-bg text-danger",
  };
  return (
    <span title={describe(quote)} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${tint[badge.tone]}`}>
      <FileText className="h-3 w-3" aria-hidden />
      {badge.label}
      {quote && quote.status !== "DRAFT" && <span className="tabular-nums opacity-80">{formatCurrency(quote.total, quote.currency)}</span>}
    </span>
  );
}
