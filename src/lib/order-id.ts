export function formatOrderId(seq: number) {
  return `ORD-${String(seq).padStart(6, "0")}`;
}

export function formatItemId(seq: number) {
  return `ITM-${String(seq).padStart(6, "0")}`;
}

/** Pulls the number out of an ITM-000123 / ORD-000123 style reference, or a bare number. */
export function parseSeqQuery(query: string) {
  const match = query.trim().match(/^(?:[A-Za-z]{3}-)?0*(\d+)$/);
  return match ? Number(match[1]) : null;
}
