/** A cancellation's reason, as kept (src/lib/documents/cancellation.ts) — plain, for the dialog and the server alike. */

export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 500;

/** A reason as kept — or the words to refuse with. */
export function cancelReasonOrRefusal(reason: string | null | undefined): { ok: true; reason: string } | { ok: false; error: string } {
  const clean = (reason ?? "").replace(/\s+/g, " ").trim();
  if (clean.length < CANCEL_REASON_MIN) return { ok: false, error: "Say why it's being cancelled — the reason is kept with the document." };
  if (clean.length > CANCEL_REASON_MAX) return { ok: false, error: `Keep the reason to ${CANCEL_REASON_MAX} characters.` };
  return { ok: true, reason: clean };
}
