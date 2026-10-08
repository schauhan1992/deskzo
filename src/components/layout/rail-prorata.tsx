"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowUpRight, Check, Copy, FileText, Loader2 } from "lucide-react";
import { addableSubscriptions, quoteAddon } from "@/actions/addon";
import { createProposalFromAddonQuote } from "@/actions/addon-proposal";
import { listCompanyOptions } from "@/actions/company";
import { proRataMonths } from "@/lib/subscriptions/proration";
import { addonQuote } from "@/lib/subscriptions/addon-quote";
import { Button } from "@/components/ui/button";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { Input, Label, Select } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

type Subscription = Awaited<ReturnType<typeof addableSubscriptions>>[number];
type Quote = NonNullable<Awaited<ReturnType<typeof quoteAddon>>>;

/**
 * What to charge for seats added part-way through a term.
 *
 * The question this business answers every week: a customer on ten seats until August wants five
 * more in November, the extra seats have to expire on the same day, and somebody has to work out
 * what a part-term costs.
 *
 * Driven from the customer's actual orders rather than from typed figures, because the typing is
 * where it goes wrong — the price a product was *sold* at is rarely list price, and a quote worked
 * out from list is one the customer will not recognise. Picking the order takes the price, the term
 * and the expiry off the record itself.
 *
 * The figure comes from `quoteAddon`, the same action the real addon flow calls, so what this shows
 * is what the order will carry — including its refusals. A calculator that quietly quoted for a
 * subscription the system would not let you add to is worse than one that says why not.
 */
export function RailProRata({ canPropose }: { canPropose: boolean }) {
  const clock = useClock();
  const today = clock.today();

  const [companies, setCompanies] = useState<{ id: string; name: string }[] | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [subId, setSubId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [addOn, setAddOn] = useState(today);
  const [byMonth, setByMonth] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showText, setShowText] = useState(false);
  const [drafted, setDrafted] = useState<{ id: string; docNumber: string | null } | null>(null);
  const [drafting, startDrafting] = useTransition();

  useEffect(() => {
    let live = true;
    listCompanyOptions({ relationshipTypes: ["CLIENT"] })
      .then((rows) => live && setCompanies(rows.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => live && setError("Could not load customers."));
    return () => {
      live = false;
    };
  }, []);

  /**
   * Clearing the previous customer's orders as the choice changes, during render rather than in an
   * effect — setting state synchronously inside an effect body causes a second render pass and the
   * React compiler refuses it. Without this there is a moment where one customer's subscriptions
   * are listed under another's name.
   */
  const [loadedFor, setLoadedFor] = useState(companyId);
  if (loadedFor !== companyId) {
    setLoadedFor(companyId);
    setSubs(null);
    setSubId("");
    setQuote(null);
  }

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    addableSubscriptions(companyId)
      .then((rows) => live && setSubs(rows))
      .catch(() => live && setError("Could not load their orders."));
    return () => {
      live = false;
    };
  }, [companyId]);

  const qty = Math.max(1, Math.floor(Number(quantity) || 1));

  useEffect(() => {
    if (!subId) return;
    let live = true;
    quoteAddon({ parentId: subId, quantity: qty, startDate: addOn })
      .then((result) => live && setQuote(result))
      .catch(() => live && setError("Could not work that out."));
    return () => {
      live = false;
    };
  }, [subId, qty, addOn]);

  const chosen = subs?.find((s) => s.id === subId) ?? null;

  const [copiedFor, setCopiedFor] = useState("");
  const signature = `${subId}:${qty}:${addOn}:${byMonth}`;
  if (copied && copiedFor !== signature) {
    setCopied(false);
  }

  /**
   * The link to the draft is cleared the moment any figure changes.
   *
   * It is a link to a document holding *these* numbers, and leaving it on screen while the quantity
   * is edited would offer a salesperson a proposal for eight seats under a panel now reading twelve.
   * The draft itself stays — it exists and may well be wanted — it is just no longer what this panel
   * is describing, so pressing the button again is the honest next step.
   */
  const [draftedFor, setDraftedFor] = useState("");
  if (drafted && draftedFor !== signature) {
    setDrafted(null);
  }

  /**
   * The month basis is worked out here rather than fetched, because `quoteAddon` is the day basis —
   * it is what the order will charge, and giving it a second convention to return would invite
   * somebody to wire the wrong one into the order.
   */
  const monthly =
    quote && chosen?.startDate && chosen.endDate && quote.annualUnitPrice > 0
      ? proRataMonths({
          fullTermUnitPrice: quote.annualUnitPrice,
          quantity: qty,
          addonStart: addOn,
          parentStart: chosen.startDate,
          parentEnd: chosen.endDate,
        })
      : null;

  const shown = byMonth ? monthly : (quote?.quote ?? null);

  /**
   * The block a salesperson pastes into an email.
   *
   * Built from whichever basis is on screen, so what they copy is what they are looking at — the
   * alternative, always quoting the day basis, would hand somebody a different figure from the one
   * they just read out on the phone.
   */
  const composed =
    shown && chosen && quote && quote.problems.length === 0
      ? addonQuote({
          productName: chosen.item.name,
          quantity: qty,
          unit: chosen.item.unit,
          from: addOn,
          to: chosen.endDate!,
          baseUnitPrice: quote.annualUnitPrice,
          taxRatePercent: Number(chosen.item.taxRatePercent ?? 18),
          proRata: shown,
        })
      : null;
  const unit = byMonth ? "month" : "day";

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="pr-company">Customer</Label>
        {companies ? (
          <CompanyCombobox
            id="pr-company"
            companies={companies}
            value={companyId}
            onSelect={(company) => setCompanyId(company?.id ?? "")}
            placeholder="Type to search customers…"
          />
        ) : (
          <p className="flex items-center gap-1.5 text-sm text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </p>
        )}
      </div>

      {companyId && (
        <div className="space-y-1.5">
          <Label htmlFor="pr-sub">Their subscription</Label>
          {!subs ? (
            <p className="text-sm text-muted">Loading their orders…</p>
          ) : subs.length === 0 ? (
            /* Expired and cancelled ones are already excluded by `addableSubscriptions`, so this
               means there is genuinely nothing to add to — which is a renewal conversation. */
            <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
              No live subscriptions. Anything expired has to be renewed rather than added to.
            </p>
          ) : (
            <Select id="pr-sub" value={subId} onChange={(e) => setSubId(e.target.value)}>
              <option value="">Choose…</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.item.name} — {s.quantity} × {inr(Number(s.fullTermUnitPrice ?? s.unitPrice ?? 0))}
                </option>
              ))}
            </Select>
          )}
        </div>
      )}

      {chosen && (
        <dl className="space-y-1 rounded-base border border-line px-3 py-2 text-xs">
          {/* What it was sold at, not list price — the whole reason for picking the order. */}
          <Row label="Sold at" value={`${inr(Number(chosen.fullTermUnitPrice ?? chosen.unitPrice ?? 0))} per ${chosen.item.unit ?? "seat"}`} />
          {/* The order's days, as typed — held as midnight UTC. */}
          <Row label="Term" value={`${formatCalendarDay(chosen.startDate)} – ${formatCalendarDay(chosen.endDate)}`} />
          <Row label="Already on it" value={`${chosen.quantity}${addonCount(chosen) ? ` + ${addonCount(chosen)} added` : ""}`} />
        </dl>
      )}

      {subId && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="pr-qty">Seats to add</Label>
              <Input
                id="pr-qty"
                inputMode="numeric"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pr-addon">From</Label>
              <Input id="pr-addon" type="date" value={addOn} onChange={(e) => setAddOn(e.target.value)} />
            </div>
          </div>

          <div className="flex rounded-md border border-line-strong p-0.5 text-xs">
            {[
              { on: false, label: "By days" },
              { on: true, label: "By months" },
            ].map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={byMonth === option.on}
                onClick={() => setByMonth(option.on)}
                className={`flex-1 rounded px-2 py-1.5 font-medium transition-colors ${
                  byMonth === option.on ? "bg-brand text-brand-contrast" : "text-muted hover:bg-surface-sunken"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}

      {/* The same refusals the real addon form gives, in the same words. */}
      {quote?.problems.map((problem) => (
        <p key={problem.field} className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
          {problem.message}
        </p>
      ))}

      {shown && quote?.problems.length === 0 && (
        <div className="space-y-2">
          <dl className="space-y-1 rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
            <Row label="Per seat" value={inr(shown.unitPrice)} />
            <Row label={unit === "day" ? "Daily rate" : "Monthly rate"} value={inr(round2(shown.dailyRate))} />
            <Row label="Charged for" value={`${shown.daysCharged} of ${shown.fullTermDays} ${unit}s`} />
            <div className="border-t border-line pt-1">
              <Row label={`Total for ${qty} seat${qty === 1 ? "" : "s"}`} value={inr(shown.total)} strong />
            </div>
          </dl>

          {composed && (
            <>
              <dl className="space-y-1 rounded-base bg-surface-sunken px-3 py-2.5 text-sm">
                <Row label="Excl. tax" value={inr(composed.totalExclTax)} />
                <Row label={`GST ${Number(chosen?.item.taxRatePercent ?? 18)}%`} value={inr(composed.taxAmount)} />
                <div className="border-t border-line pt-1">
                  <Row label="Payable" value={inr(composed.totalInclTax)} strong />
                </div>
              </dl>

              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={async () => {
                  /**
                   * The clipboard can refuse, and does: an unfocused document, a denied
                   * permission, or a page served over plain HTTP all reject here. Left unhandled
                   * the button does nothing at all and the salesperson pastes whatever was on the
                   * clipboard before — which on this screen could be the last customer's pricing.
                   * Failing loudly and showing the text to select by hand is the honest fallback.
                   */
                  try {
                    /**
                     * Both flavours on the clipboard at once.
                     *
                     * Gmail and Outlook take the HTML and paste a table; WhatsApp and a plain-text
                     * reply take the text. Writing only one would mean choosing on the
                     * salesperson's behalf which of those they are about to paste into.
                     */
                    if (typeof ClipboardItem === "function" && navigator.clipboard.write) {
                      await navigator.clipboard.write([
                        new ClipboardItem({
                          "text/html": new Blob([composed.html], { type: "text/html" }),
                          "text/plain": new Blob([composed.text], { type: "text/plain" }),
                        }),
                      ]);
                    } else {
                      // Older browsers have no `ClipboardItem`. The text still goes across, which
                      // is the part that must never fail.
                      await navigator.clipboard.writeText(composed.text);
                    }
                    setCopied(true);
                    setCopiedFor(signature);
                    setError(null);
                  } catch {
                    setCopied(false);
                    setShowText(true);
                    setError("Your browser would not let the page write to the clipboard. Select the text below instead.");
                  }
                }}
              >
                {copied ? (
                  <>
                    <Check className="mr-1.5 h-3.5 w-3.5" />
                    Copied — paste into the email
                  </>
                ) : (
                  <>
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy the quote
                  </>
                )}
              </Button>

              {/**
                * Raising the quote as a document, rather than only as text to paste.
                *
                * The figures are not sent — only which subscription, how many seats, from when, and
                * which basis is on screen. The action works the price out again from the order, so
                * what the proposal carries cannot differ from what the panel just showed, and a
                * price cannot be posted in from outside.
                */}
              {/* Only for somebody who may raise one: a button that can only ever refuse is worse than none. */}
              {!canPropose ? null : drafted ? (
                /* The number truncates and "Open" never does: the rail is 288px wide at anything
                   below a large screen, and a document number is free text that can be as long as
                   whoever set the numbering format wanted. Keeping the action at full width and
                   letting the label give way is the right way round — the number is confirmation,
                   the link is the point. */
                <Link
                  href={`/documents/${drafted.id}`}
                  className="flex w-full items-center justify-between gap-2 rounded-base border border-success/40 bg-success-bg px-3 py-2 text-xs font-medium text-success transition-colors hover:border-success"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">{drafted.docNumber ?? "Proposal"} drafted</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    Open
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              ) : (
                <Button
                  size="sm"
                  className="w-full"
                  disabled={drafting}
                  onClick={() => {
                    setError(null);
                    startDrafting(async () => {
                      const result = await createProposalFromAddonQuote({
                        parentId: subId,
                        quantity: qty,
                        startDate: addOn,
                        basis: byMonth ? "MONTH" : "DAY",
                      });
                      if (!result.ok) setError(result.error);
                      else {
                        setDrafted(result.data);
                        setDraftedFor(signature);
                      }
                    });
                  }}
                >
                  {drafting ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Creating the draft…
                    </>
                  ) : (
                    <>
                      <FileText className="mr-1.5 h-3.5 w-3.5" />
                      Create proposal
                    </>
                  )}
                </Button>
              )}

              {showText && (
                <textarea
                  readOnly
                  value={composed.text}
                  rows={14}
                  aria-label="The quote, to copy by hand"
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-base border border-line-strong bg-surface px-2 py-1.5 font-mono text-[11px] text-text"
                />
              )}
            </>
          )}

          {/* The sentence the order note and the invoice line carry, so a customer querying the
              figure gets the same explanation wherever they ask. */}
          <p className="text-xs text-subtle">{shown.workings}</p>
        </div>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      {!companyId && (
        <p className="text-xs text-subtle">
          New seats co-terminate with the subscription they join, so they are charged only to the day it expires.
        </p>
      )}
    </div>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(n);

/** Seats added since, so "already on it" reflects what the customer actually has. */
function addonCount(sub: Subscription) {
  return sub.addons.reduce((sum, a) => sum + a.quantity, 0);
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`font-mono tabular-nums ${strong ? "font-semibold text-text" : "text-muted"}`}>{value}</dd>
    </div>
  );
}
