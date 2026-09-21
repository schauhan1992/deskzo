/**
 * What a reseller pays for an item, in priority order:
 *   1. a price negotiated for that specific item (`ResellerItemPrice`)
 *   2. their tier's standard discount off the catalog price
 *   3. the catalog price
 *
 * Returns the source alongside the price so the punch form can say *why* it filled that number in
 * — a salesperson seeing an unexpected price needs to know whether it came from a special deal or
 * the tier slab.
 */
export type ResellerPriceSource = "special" | "tier" | "catalog";

export type ResolvedPrice = {
  unitPrice: number;
  source: ResellerPriceSource;
  /** Only set for the tier source. */
  discountPercent?: number;
};

export function resolveResellerPrice({
  catalogPrice,
  specialPrice,
  discountPercent,
}: {
  catalogPrice: number;
  specialPrice?: number | null;
  discountPercent?: number | null;
}): ResolvedPrice {
  if (specialPrice !== null && specialPrice !== undefined) {
    return { unitPrice: round2(specialPrice), source: "special" };
  }
  if (discountPercent) {
    return {
      unitPrice: round2(catalogPrice * (1 - discountPercent / 100)),
      source: "tier",
      discountPercent,
    };
  }
  return { unitPrice: round2(catalogPrice), source: "catalog" };
}

export function describePriceSource(resolved: ResolvedPrice) {
  if (resolved.source === "special") return "Special price agreed with this reseller";
  if (resolved.source === "tier") return `${resolved.discountPercent}% partner tier discount applied`;
  return "Catalog price — no reseller pricing set";
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
