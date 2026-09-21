import { normalizeCompanyName } from "@/lib/validation/company";

/**
 * Comparing what a distributor billed us for against what we actually sold.
 *
 * ## Why this exists
 *
 * Two records of the same subscriptions drift apart constantly, and always in the direction that
 * costs money. A customer's own admin adds five seats — the distributor bills for them and nobody
 * here raises an invoice. A subscription auto-renews that the customer believed was cancelled. A
 * customer stops paying and the seats stay provisioned for another year. None of that is visible in
 * a 200-line PDF, and none of it is anybody's job to notice.
 *
 * ## What it does not do
 *
 * It does not decide anything. Every disagreement is reported for a person to look at, because each
 * one has several innocent explanations and several expensive ones, and which it is depends on facts
 * this function does not have. The value is in *finding* the twelve lines out of two hundred that
 * are worth twenty minutes.
 *
 * Pure, and covered by `scripts/check-reconcile.ts`.
 */

export type StatementRow = {
  rowNumber: number;
  sku: string;
  description?: string | null;
  /** Whatever the vendor calls the customer: a name, a tenant domain, or our own PO reference. */
  customerRef: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
};

/** One of our orders, as it stands. */
export type SoldOrder = {
  orderId: string;
  companyId: string;
  companyName: string;
  /**
   * Other strings that legitimately identify the same customer: a tenant domain, a website, a
   * trading name, the end customer behind a reseller. A distributor almost never writes the same
   * name we do.
   */
  aliases: string[];
  sku: string;
  quantity: number;
  /** What we recorded paying per unit for the full term. Null when nobody filled it in. */
  purchasePrice: number | null;
  startDate: Date | null;
  endDate: Date | null;
  /** Shown on an exception so somebody can act without opening another tab. */
  orderLabel?: string | null;
  /** Who we bought it from, when the purchase team recorded it. Routinely null. */
  vendorId?: string | null;
};

export type ReconcileState =
  | "MATCHED"
  | "QUANTITY_MISMATCH"
  | "PRICE_MISMATCH"
  | "BILLED_NOT_SOLD"
  | "UNKNOWN_SKU"
  | "UNKNOWN_CUSTOMER"
  | "AMBIGUOUS"
  | "SOLD_NOT_BILLED";

export type Billing = "MONTHLY" | "ANNUAL" | "ONE_OFF";

export type Verdict = {
  rowNumber: number | null;
  source: "STATEMENT" | "OURS";
  state: ReconcileState;
  sku: string;
  customerRef: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  matchedOrderId: string | null;
  matchedCompanyId: string | null;
  /** Signed, in rupees. Positive means it cost us money. */
  variance: number;
  note: string;
};

export type Reconciliation = {
  lines: Verdict[];
  summary: {
    total: number;
    matched: number;
    exceptions: number;
    /** The sum of every positive variance — what this statement is worth chasing. */
    atRisk: number;
    byState: Record<ReconcileState, number>;
    /**
     * Orders live in this period with no supplier recorded.
     *
     * They cannot be checked against any one vendor's statement, so they are neither reported nor
     * quietly forgotten — the page says how many, which is both an honest caveat on the result and
     * the nudge that fixes it.
     */
    uncheckable: number;
  };
};

/**
 * Two SKUs are the same SKU.
 *
 * Case and stray whitespace only, on the strict pass. Deliberately *not* stripping punctuation:
 * `CFQ7TTC0LH18-0001` and `CFQ7TTC0LH18-0002` are different products, and a normaliser that removed
 * the dash and the leading zeros would happily reconcile one against the other. The looser pass
 * below exists for the real-world case of a vendor writing `CFQ7TTC0LH18 0001`, and it is only
 * consulted when the strict pass found nothing.
 */
export function skuKey(sku: string): string {
  return sku.trim().toUpperCase().replace(/\s+/g, " ");
}

/** The fallback: alphanumerics only. Used only when nothing matched strictly. */
export function loseSkuKey(sku: string): string {
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Two customer references are the same customer.
 *
 * Built on the app's own `normalizeCompanyName` rather than a second rule, because a matcher that
 * normalises differently from the rest of the system will disagree with the duplicate check, the
 * importer and the search box — each in its own direction.
 *
 * A domain-looking reference is reduced to its registrable part, so `contoso.onmicrosoft.com`,
 * `contoso.com` and `mail.contoso.com` all land on `contoso` — which is the single most common way
 * a Microsoft statement names a customer.
 */
export function customerKey(ref: string): string {
  const trimmed = ref.trim().toLowerCase();
  if (!trimmed) return "";

  const domain = trimmed.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0]!;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
    const parts = domain.split(".");
    // `contoso.onmicrosoft.com` → contoso, and `contoso.co.in` → contoso.
    if (parts.length >= 3 && (parts.at(-2) === "onmicrosoft" || parts.at(-2) === "co")) {
      return parts.at(-3) ?? parts[0]!;
    }
    return parts.at(-2) ?? parts[0]!;
  }

  return normalizeCompanyName(trimmed);
}

/** Whether two date ranges touch at all. An open end is treated as still running. */
export function overlaps(
  a: { start: Date | null; end: Date | null },
  b: { start: Date; end: Date },
): boolean {
  const startsBeforeEnd = !a.start || a.start.getTime() <= b.end.getTime();
  const endsAfterStart = !a.end || a.end.getTime() >= b.start.getTime();
  return startsBeforeEnd && endsAfterStart;
}

/**
 * What one unit on this statement should have cost.
 *
 * `purchasePrice` records the full term. A monthly line bills a twelfth of it, so comparing the two
 * directly makes every monthly statement look wrong by a factor of twelve — which in practice means
 * the price check gets switched off and real overbilling goes through with it.
 */
export function expectedUnitCost(purchasePrice: number, billing: Billing): number {
  return billing === "MONTHLY" ? purchasePrice / 12 : purchasePrice;
}

/**
 * How far apart two costs may be before it is worth telling somebody.
 *
 * A twelfth of an annual price rarely divides into whole paise, and exchange-rate rounding moves
 * the last rupee on a large line. One rupee or one percent, whichever is larger: small enough to
 * catch a real price change, loose enough that a page of rounding noise never appears.
 */
export function withinTolerance(expected: number, actual: number): boolean {
  return Math.abs(expected - actual) <= Math.max(1, Math.abs(expected) * 0.01);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Runs the comparison.
 *
 * `sold` is every order that could plausibly be on this statement — the caller narrows by vendor and
 * by period overlap, and this narrows the rest of the way. Orders left over at the end are the
 * `SOLD_NOT_BILLED` half, which is the direction nobody thinks to look in: a subscription we are
 * invoicing a customer for and the distributor has stopped charging us for is usually one that was
 * never actually provisioned.
 */
export function reconcile(
  rows: StatementRow[],
  sold: SoldOrder[],
  period: { start: Date; end: Date },
  options: {
    billing?: Billing;
    /**
     * Every SKU in the catalogue, not only the ones with orders.
     *
     * The distinction it buys is the difference between two different jobs: a SKU we do not stock is
     * a catalogue entry to add (or a column mapped to the wrong field), while a SKU we stock and have
     * sold to nobody on this statement is a line to query with the distributor. Without the
     * catalogue both look identical and both get the wrong advice.
     */
    catalogSkus?: Iterable<string>;
    /**
     * Whose statement this is.
     *
     * Only used to decide which of our orders may be reported as missing from it — see the
     * `SOLD_NOT_BILLED` pass below. Never used to *exclude* an order from matching, because an
     * order with the wrong vendor recorded still wants to be found.
     */
    vendorId?: string | null;
    /**
     * Whether an absence means anything.
     *
     * True for a whole month's statement, where one of our live orders not appearing is a finding.
     * False for a handful of lines somebody typed to check one thing — there every other order is
     * missing by construction, and reporting them buries the line they came to look at. A three-line
     * check against a vendor with forty orders produced thirty-seven "sold, not billed" before this
     * existed.
     */
    reportMissing?: boolean;
  } = {},
): Reconciliation {
  const billing = options.billing ?? "MONTHLY";
  const inCatalogue = new Set<string>();
  const inCatalogueLoose = new Set<string>();
  for (const sku of options.catalogSkus ?? []) {
    inCatalogue.add(skuKey(sku));
    inCatalogueLoose.add(loseSkuKey(sku));
  }
  const bySku = new Map<string, SoldOrder[]>();
  const byLooseSku = new Map<string, SoldOrder[]>();

  const push = (map: Map<string, SoldOrder[]>, key: string, order: SoldOrder) => {
    const existing = map.get(key);
    if (existing) existing.push(order);
    else map.set(key, [order]);
    // Any SKU with an order is necessarily one we stock, whatever the caller passed.
    if (map === bySku) inCatalogue.add(key);
    else inCatalogueLoose.add(key);
  };

  for (const order of sold) {
    push(bySku, skuKey(order.sku), order);
    push(byLooseSku, loseSkuKey(order.sku), order);
  }

  const lines: Verdict[] = [];
  /** Orders a statement line was matched to — anything left is `SOLD_NOT_BILLED`. */
  const seen = new Set<string>();

  for (const row of rows) {
    const strict = skuKey(row.sku);
    const candidatesBySku = bySku.get(strict) ?? byLooseSku.get(loseSkuKey(row.sku)) ?? [];

    const base = {
      rowNumber: row.rowNumber,
      source: "STATEMENT" as const,
      sku: row.sku,
      customerRef: row.customerRef,
      quantity: row.quantity,
      unitCost: row.unitCost,
      lineTotal: row.lineTotal,
      matchedOrderId: null,
      matchedCompanyId: null,
    };

    if (candidatesBySku.length === 0) {
      // The whole line is money out with nothing here to set against it, so the variance is all of it.
      const stocked = inCatalogue.has(strict) || inCatalogueLoose.has(loseSkuKey(row.sku));
      lines.push({
        ...base,
        state: stocked ? "BILLED_NOT_SOLD" : "UNKNOWN_SKU",
        variance: round2(row.lineTotal),
        note: stocked
          ? "We stock this SKU and have no live order for it with anyone on this statement."
          : "This SKU is not in the catalogue. Add the item, or check the mapping is reading the right column.",
      });
      continue;
    }

    const wanted = customerKey(row.customerRef);
    const byCustomer = candidatesBySku.filter((order) =>
      [order.companyName, ...order.aliases].some((alias) => alias && customerKey(alias) === wanted),
    );

    if (byCustomer.length === 0) {
      lines.push({
        ...base,
        state: "UNKNOWN_CUSTOMER",
        variance: round2(row.lineTotal),
        note: `No company matches “${row.customerRef}”. It may be a tenant name we have not recorded.`,
      });
      continue;
    }

    const rowPeriod = {
      start: row.periodStart ?? period.start,
      end: row.periodEnd ?? period.end,
    };
    const inPeriod = byCustomer.filter((order) =>
      overlaps({ start: order.startDate, end: order.endDate }, rowPeriod),
    );

    if (inPeriod.length === 0) {
      lines.push({
        ...base,
        state: "BILLED_NOT_SOLD",
        matchedCompanyId: byCustomer[0]!.companyId,
        variance: round2(row.lineTotal),
        note: "This customer has this SKU, but no order of ours covers the billed period — a lapsed or cancelled subscription still being charged for.",
      });
      continue;
    }

    if (inPeriod.length > 1) {
      /**
       * Two orders for the same customer and SKU both covering the period — usually a renewal
       * overlapping the term it replaced. Picking one silently would produce a confident wrong
       * answer, and a confident wrong answer is worse here than an admitted unknown.
       */
      lines.push({
        ...base,
        state: "AMBIGUOUS",
        matchedCompanyId: inPeriod[0]!.companyId,
        variance: 0,
        note: `${inPeriod.length} of our orders could be this line. Close or date the overlapping one and re-run.`,
      });
      continue;
    }

    const order = inPeriod[0]!;
    seen.add(order.orderId);

    const matched = {
      ...base,
      matchedOrderId: order.orderId,
      matchedCompanyId: order.companyId,
    };

    if (row.quantity !== order.quantity) {
      /**
       * Seats, and the reason this module was built. The variance is the *extra* seats at the billed
       * rate: what is being paid for and not invoiced to anybody.
       */
      const extra = row.quantity - order.quantity;
      lines.push({
        ...matched,
        state: "QUANTITY_MISMATCH",
        variance: round2(extra * row.unitCost),
        note:
          extra > 0
            ? `Billed for ${row.quantity}, our order says ${order.quantity} — ${extra} seat${extra === 1 ? "" : "s"} nobody is being invoiced for.`
            : `Billed for ${row.quantity}, our order says ${order.quantity} — we may be invoicing for ${-extra} seat${extra === -1 ? "" : "s"} that are not provisioned.`,
      });
      continue;
    }

    if (order.purchasePrice === null) {
      // Not a mismatch: nothing was recorded to disagree with. Said out loud rather than passed as
      // matched, because "we have no idea what this cost" is worth one person's attention once.
      lines.push({
        ...matched,
        state: "MATCHED",
        variance: 0,
        note: "Quantity agrees. No cost recorded on our order, so the price could not be checked.",
      });
      continue;
    }

    const expected = expectedUnitCost(order.purchasePrice, billing);
    if (!withinTolerance(expected, row.unitCost)) {
      lines.push({
        ...matched,
        state: "PRICE_MISMATCH",
        variance: round2((row.unitCost - expected) * row.quantity),
        note: `Billed ₹${row.unitCost.toFixed(2)} a unit, our order implies ₹${expected.toFixed(2)}.`,
      });
      continue;
    }

    lines.push({ ...matched, state: "MATCHED", variance: 0, note: "" });
  }

  /**
   * The other direction.
   *
   * An order we are billing a customer for that the distributor has stopped charging us for. Benign
   * when it is billed elsewhere; expensive when it means the subscription was never provisioned and
   * the customer is about to find out.
   *
   * ## Which orders can be checked in this direction at all
   *
   * Only the ones that record **this** vendor as the supplier. One distributor's statement covers
   * what we buy from that distributor, so an order sourced elsewhere is legitimately absent and
   * saying otherwise is noise.
   *
   * The harder case is an order with no supplier recorded — which is a great many of them, because
   * `vendorId` is set by the purchase team after approval. An earlier version guessed: if this
   * statement bills that SKU for somebody else, the distributor evidently supplies it, so a missing
   * one is suspicious. It produced 152 findings on a real file, and the number turned out to depend
   * on how much SKU overlap the catalogue happens to have rather than on anything true.
   *
   * So they are not guessed at and not silently dropped. They are **counted**, and the page says how
   * many could not be checked and why. That is honest, it stays quiet, and it points at the fix —
   * record the supplier on the order — instead of burying seven real findings under a hundred and
   * fifty maybes.
   */
  let uncheckable = 0;

  // A partial statement says nothing about what is not on it.
  const reportMissing = options.reportMissing ?? true;

  for (const order of sold) {
    if (!reportMissing) break;
    if (seen.has(order.orderId)) continue;
    if (!overlaps({ start: order.startDate, end: order.endDate }, period)) continue;

    if (!order.vendorId) {
      uncheckable += 1;
      continue;
    }
    if (!options.vendorId || order.vendorId !== options.vendorId) continue;

    const expected = order.purchasePrice === null ? 0 : expectedUnitCost(order.purchasePrice, billing);
    lines.push({
      rowNumber: null,
      source: "OURS",
      state: "SOLD_NOT_BILLED",
      sku: order.sku,
      customerRef: order.companyName,
      quantity: order.quantity,
      unitCost: round2(expected),
      lineTotal: round2(expected * order.quantity),
      matchedOrderId: order.orderId,
      matchedCompanyId: order.companyId,
      // Negative: not being charged for it is money we are keeping, until it turns out the customer
      // has no subscription. The number is the size of the question, not a gain.
      variance: round2(-expected * order.quantity),
      note: "Live on our side for this period, and not on the statement. Check it was actually provisioned.",
    });
  }

  const byState = {
    MATCHED: 0,
    QUANTITY_MISMATCH: 0,
    PRICE_MISMATCH: 0,
    BILLED_NOT_SOLD: 0,
    UNKNOWN_SKU: 0,
    UNKNOWN_CUSTOMER: 0,
    AMBIGUOUS: 0,
    SOLD_NOT_BILLED: 0,
  } satisfies Record<ReconcileState, number>;
  for (const line of lines) byState[line.state] += 1;

  return {
    lines,
    summary: {
      total: lines.length,
      matched: byState.MATCHED,
      exceptions: lines.length - byState.MATCHED,
      atRisk: round2(lines.reduce((sum, l) => sum + Math.max(0, l.variance), 0)),
      byState,
      uncheckable,
    },
  };
}

/** For the UI: what each state means and how loudly to say it. */
export const STATE_LABELS: Record<ReconcileState, { label: string; tone: "green" | "red" | "amber" | "blue" | "default"; blurb: string }> = {
  MATCHED: { label: "Matched", tone: "green", blurb: "Quantity and cost agree with our order." },
  QUANTITY_MISMATCH: { label: "Seat mismatch", tone: "red", blurb: "Billed for a different number of seats than we sold." },
  PRICE_MISMATCH: { label: "Price mismatch", tone: "red", blurb: "Billed at a different unit cost than our order records." },
  BILLED_NOT_SOLD: { label: "Billed, not sold", tone: "red", blurb: "Being charged for something no live order of ours covers." },
  UNKNOWN_SKU: { label: "Unknown SKU", tone: "amber", blurb: "Not in the catalogue — add the item, or fix the column mapping." },
  UNKNOWN_CUSTOMER: { label: "Unknown customer", tone: "amber", blurb: "The name on the statement matches no company here." },
  AMBIGUOUS: { label: "Ambiguous", tone: "amber", blurb: "Several of our orders could be this line." },
  SOLD_NOT_BILLED: { label: "Sold, not billed", tone: "blue", blurb: "Live on our side and absent from the statement — check it was provisioned." },
};
