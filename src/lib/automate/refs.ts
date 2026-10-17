/**
 * How a run is named and addressed (Deskzo Automate): RUN-000123, at /automate/runs/RUN-000123 —
 * readable, as record addresses are (src/lib/record-links.ts). The bare number resolves too. Pure.
 */

export function runRef(seq: number): string {
  return `RUN-${String(seq).padStart(6, "0")}`;
}

export function runPath(seq: number): string {
  return `/automate/runs/${runRef(seq)}`;
}

/** The run number in "RUN-000123" or "123", or null. */
export function parseRunRef(ref: string): number | null {
  const m = /^(?:RUN-)?0*(\d{1,10})$/i.exec(ref.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
