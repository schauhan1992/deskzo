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

/** A workflow: WF-0042, at /automate/workflows/WF-0042 — the builder. */
export function workflowRef(seq: number): string {
  return `WF-${String(seq).padStart(4, "0")}`;
}

export function workflowPath(seq: number): string {
  return `/automate/workflows/${workflowRef(seq)}`;
}

/** The workflow number in "WF-0042" or "42", or null. */
export function parseWorkflowRef(ref: string): number | null {
  const m = /^(?:WF-)?0*(\d{1,10})$/i.exec(ref.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
