"use client";

import Link from "next/link";
import { cn, formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ItemComboOption } from "@/components/items/item-combobox";
import { SummaryRow } from "./parts";
import { useOrderFigures, usePriceFigures } from "./use-figures";
import type { PunchForm } from "./types";

const COST_BASIS: Record<"DEAL" | "QUOTE", string> = { DEAL: "deal price", QUOTE: "distributor's price" };

/** "₹1,200 (12%)" — a margin with its share of the sale, when there is a sale to share. */
function marginText(amount: number, percent: number | null) {
  return `${formatCurrency(amount)}${percent !== null ? ` (${percent}%)` : ""}`;
}

/**
 * The order as it stands, beside the form on a wide screen and after it on a narrow one: what is
 * sold, the total with GST, the margin, and the buttons that punch it.
 *
 * The margin is the front margin — sale less cost less expenses, what targets count. The rebate and
 * the net margin after it are for whoever may see rebates, and are not rendered for anybody else.
 */
export function OrderSummary({
  form,
  selectedItem,
  canSeeRebates,
  serverError,
  busy,
  submitting,
  justPunched,
  onCancel,
}: {
  form: PunchForm;
  selectedItem: ItemComboOption | null;
  canSeeRebates: boolean;
  serverError: string | null;
  /** Submitting, or on the way to the order just punched: the buttons stay off until the page changes. */
  busy: boolean;
  submitting: boolean;
  /** The reference of the order punched with "Punch and add another", for the line linking to it. */
  justPunched: string | null;
  onCancel: () => void;
}) {
  const figures = useOrderFigures(form.control, selectedItem);
  const belowList = figures.belowListPercent;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-medium text-text">Order summary</h2>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2">
          <div>
            <p className="font-medium text-text">
              {selectedItem ? `${selectedItem.name} × ${figures.quantity}` : "No product chosen yet"}
            </p>
            {selectedItem && (
              <p className="text-xs text-muted">
                {figures.unitPrice !== null ? `${formatCurrency(figures.unitPrice)} a unit` : "No price yet"}
                {figures.priceTyped && figures.listPrice !== null ? ` · list ${formatCurrency(figures.listPrice)}` : " · list price"}
                {belowList !== null && (belowList > 0 ? ` · ${belowList}% below` : ` · ${Math.abs(belowList)}% above`)}
              </p>
            )}
          </div>
          <SummaryRow label="Subtotal" value={formatCurrency(figures.subtotal)} />
          <SummaryRow label={`GST (${figures.taxRate}%)`} value={formatCurrency(figures.gstAmount)} />
          <SummaryRow
            label="Total incl. GST"
            value={formatCurrency(figures.total)}
            className="border-t border-line pt-2 text-base font-semibold [&>span]:text-text"
          />
        </div>

        <div className="space-y-2 border-t border-line pt-3">
          <SummaryRow
            label="Cost basis"
            value={
              figures.unitCost !== null && figures.costSource
                ? `${formatCurrency(figures.unitCost)} · ${COST_BASIS[figures.costSource]}`
                : "—"
            }
          />
          <SummaryRow
            label={figures.expensesTotal > 0 ? "Front margin, after expenses" : "Front margin"}
            value={
              figures.frontMargin !== null ? (
                <span className={figures.frontMargin < 0 ? "text-danger" : undefined}>
                  {marginText(figures.frontMargin, figures.frontMarginPercent)}
                </span>
              ) : (
                "—"
              )
            }
          />
          {figures.unitCost === null && (
            <p className="text-xs text-subtle">Add a distributor or deal price under Cost and margin to see it.</p>
          )}
          {figures.belowCost && (
            <p className="rounded-md bg-danger-bg px-3 py-2 text-xs text-danger">
              Sold below cost — a manager approves it before it goes ahead.
            </p>
          )}
          {canSeeRebates && (
            <>
              <SummaryRow
                label="Expected rebate"
                value={figures.rebateExpected.length > 0 ? formatCurrency(figures.rebateTotal) : "—"}
              />
              <SummaryRow
                label="Net margin"
                value={
                  figures.netMargin !== null ? (
                    <span className={figures.netMargin >= 0 ? "text-success" : "text-danger"}>{formatCurrency(figures.netMargin)}</span>
                  ) : (
                    "—"
                  )
                }
              />
            </>
          )}
        </div>

        {serverError && (
          <div role="alert" className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
            {serverError}
          </div>
        )}
        {/* Always in the page, so the line is announced when it fills rather than missed as it appears. */}
        <div role="status" aria-live="polite">
          {justPunched && (
            <p className="rounded-md bg-success-bg px-3 py-2 text-xs text-success">
              <Link href={`/orders/${justPunched}`} className="font-medium underline underline-offset-2">
                {justPunched}
              </Link>{" "}
              punched. Choose the next product.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Button type="submit" className="w-full" disabled={busy}>
            {submitting ? "Punching…" : "Punch order"}
          </Button>
          {/* The form reads which button sent it (`data-then`), so Enter still means the plain punch above. */}
          <Button type="submit" variant="secondary" className="w-full" data-then="another" disabled={busy}>
            Punch and add another
          </Button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-full py-1 text-center text-sm text-muted hover:text-text disabled:opacity-45"
          >
            Cancel
          </button>
        </div>
        <p className="text-xs text-subtle">Accounts approve it next; purchase sets the vendor and the price paid later.</p>
      </CardContent>
    </Card>
  );
}

/**
 * Below a wide screen the summary sits after the whole form, so the total and the button stay on
 * screen in a bar at the bottom while the form is filled in.
 */
export function PunchBar({
  form,
  selectedItem,
  busy,
  submitting,
  failed,
}: {
  form: PunchForm;
  selectedItem: ItemComboOption | null;
  busy: boolean;
  submitting: boolean;
  /** The last try came back with an error, which the summary below spells out. */
  failed: boolean;
}) {
  const { total } = usePriceFigures(form.control, selectedItem);
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-2.5",
        "backdrop-blur md:-mx-6 md:px-6 lg:hidden",
      )}
    >
      <div className="min-w-0">
        {failed ? (
          <p className="truncate text-xs text-danger">Not punched — see the summary below.</p>
        ) : (
          <p className="text-xs text-muted">Total incl. GST</p>
        )}
        <p className="font-semibold text-text tabular-nums">{formatCurrency(total)}</p>
      </div>
      <Button type="submit" disabled={busy}>
        {submitting ? "Punching…" : "Punch order"}
      </Button>
    </div>
  );
}
