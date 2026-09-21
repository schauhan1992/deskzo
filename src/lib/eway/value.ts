/**
 * What a document's goods are worth to move.
 *
 * Not the same question as what the document is for. A delivery challan charges nothing — nothing
 * is being supplied, so its taxable value is nil and its total is nil, which is correct and will
 * stay correct. The e-way bill asks something different: what are these goods worth, so that the
 * ₹50,000 threshold and the declared value on the bill can be decided.
 *
 * Reading the document total for both is how a ₹6.15 lakh movement of three laptops came out as
 * "no bill needed, ₹0 is not above ₹50,000" — the one answer that is both wrong and reassuring.
 *
 * Three sources, in order of how directly each one states the answer:
 *
 *   1. the document total, when there is one — an invoice says what the goods are worth;
 *   2. the consignment's declared value, which is what somebody put on the movement;
 *   3. the lines' own quantity × unit price, which a challan carries for identification even
 *      though it charges nothing.
 *
 * Nil is only ever returned when all three are nil, which means there is genuinely nothing to go on.
 */

export type ValuedLine = { quantity: unknown; unitPrice: unknown; taxableValue: unknown };

const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function documentGoodsValue(input: {
  total: unknown;
  consignmentValues?: unknown[];
  lines?: ValuedLine[];
}): number {
  const total = num(input.total);
  if (total > 0) return total;

  const declared = (input.consignmentValues ?? []).reduce<number>((sum, v) => sum + num(v), 0);
  if (declared > 0) return declared;

  return (input.lines ?? []).reduce((sum, l) => sum + num(l.quantity) * num(l.unitPrice), 0);
}

/**
 * The line values to declare on the bill.
 *
 * Names and HSN come from the document either way. The value is taken as it stands when the
 * document has one, and apportioned from the consignment's value when the document's own come to
 * nothing — because a bill declaring ₹0 of goods is refused by the portal on a good day and is a
 * false declaration on a bad one.
 */
export function apportionLineValues<T extends ValuedLine>(lines: T[], goodsValue: number) {
  const stated = lines.reduce((sum, l) => sum + num(l.taxableValue), 0);
  if (stated > 0 || goodsValue <= 0 || lines.length === 0) {
    return lines.map((l) => num(l.taxableValue));
  }

  // Weighted by each line's own quantity × price where those exist, so three laptops and one mouse
  // do not come out as four equal quarters. Falls back to an even split when they do not.
  const weights = lines.map((l) => num(l.quantity) * num(l.unitPrice));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight <= 0) return lines.map(() => goodsValue / lines.length);
  return weights.map((w) => (w / totalWeight) * goodsValue);
}
