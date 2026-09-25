/**
 * An email as a page for a preview frame — kept apart from src/lib/marketing/html.ts so a client
 * component can use it without pulling the HTML sanitiser into the browser.
 *
 * Shown in `<iframe sandbox="">`, so nothing in it can run. On top of that: the open pixel is taken
 * out, so looking at a sent email in its report never counts as the customer opening it, and every
 * link targets a new window — which the sandbox refuses — so a click in a preview goes nowhere and
 * is never counted as theirs.
 */
export function previewDocument(html: string): string {
  const quiet = html.replace(/<img\b[^>]*\bsrc="[^"]*\/track\/[^"]*"[^>]*>/gi, "");
  const guard = `<base target="_blank"><meta name="referrer" content="no-referrer">`;
  if (/<head[^>]*>/i.test(quiet)) return quiet.replace(/<head([^>]*)>/i, `<head$1>${guard}`);
  return `<!doctype html><html><head>${guard}<meta charset="utf-8"></head><body>${quiet}</body></html>`;
}
