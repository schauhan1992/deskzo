import { slot, type Wording } from "@/lib/terms/dictionary";

/**
 * A report's labels in the workspace's own words (Settings → Wording) — the explorer's and the printed
 * sheet's alike, so the screen and the paper name a report the same way.
 *
 * Said where a label is shown, not where it is defined: src/lib/analytics/sources.ts keeps the app's
 * words, because the CSV an import or a spreadsheet matches on, the Copilot and the checks all read
 * them there. Keyed by the label as that file writes it; anything not listed — a date, "Margin",
 * "Product", which is already not the app's word for an item — shows as it always has.
 */
const WORDED = new Map<string, (w: Wording) => string>([
  // What a report is on.
  ["Orders", (w) => slot(w, "Orders", "order", "{many}")],
  ["Leads", (w) => slot(w, "Leads", "lead", "{many}")],
  ["Tickets", (w) => slot(w, "Tickets", "ticket", "{many}")],
  ["Field visits", (w) => slot(w, "Field visits", "visit", "Field {many:lower}")],
  // The figures.
  ["Order value", (w) => slot(w, "Order value", "order", "{one} value")],
  ["Number of orders", (w) => slot(w, "Number of orders", "order", "Number of {many:lower}")],
  ["Number of leads", (w) => slot(w, "Number of leads", "lead", "Number of {many:lower}")],
  ["Tickets raised", (w) => slot(w, "Tickets raised", "ticket", "{many} raised")],
  ["Tickets resolved", (w) => slot(w, "Tickets resolved", "ticket", "{many} resolved")],
  ["Visits", (w) => slot(w, "Visits", "visit", "{many}")],
  // What they break down by — and whose a workspace's own field is ("Customer · Region").
  ["Customer", (w) => slot(w, "Customer", "customer", "{one}")],
  ["Customer tag", (w) => slot(w, "Customer tag", "customer", "{one} tag")],
  ["Company", (w) => slot(w, "Company", "company", "{one}")],
  ["Company tag", (w) => slot(w, "Company tag", "company", "{one} tag")],
  ["Lead", (w) => slot(w, "Lead", "lead", "{one}")],
  ["Lead source", (w) => slot(w, "Lead source", "lead", "{one} source")],
  ["Order", (w) => slot(w, "Order", "order", "{one}")],
  ["Order status", (w) => slot(w, "Order status", "order", "{one} status")],
  ["Vendor", (w) => slot(w, "Vendor", "vendor", "{one}")],
  ["New vs renewal", (w) => slot(w, "New vs renewal", "renewal", "New vs {one:lower}")],
]);

/**
 * A source's, a figure's or a breakdown's label as this workspace says it. One of the workspace's own
 * fields (`custom`) is labelled "<whose> · <field>" by src/lib/analytics/custom.ts: only the "whose" is
 * a word of the app's — the field's own name is the workspace's already.
 */
export function reportLabel(w: Wording, item: { label: string; custom?: boolean }): string {
  if (w.renamed.length === 0) return item.label;
  if (item.custom) {
    const at = item.label.indexOf(" · ");
    if (at < 0) return item.label;
    const whose = item.label.slice(0, at);
    return `${WORDED.get(whose)?.(w) ?? whose}${item.label.slice(at)}`;
  }
  return WORDED.get(item.label)?.(w) ?? item.label;
}

/**
 * Every label the explorer shows of its sources, in the workspace's words — keys untouched. Typed by the
 * labels it rewords rather than by the analytics actions' SourceOption, so this plain module borrows no
 * module's actions (check:module-guards).
 */
type Labelled = { label: string; custom?: boolean };
export function wordedSources<S extends Labelled & { measures: Labelled[]; dimensions: Labelled[] }>(w: Wording, sources: S[]): S[] {
  if (w.renamed.length === 0) return sources;
  return sources.map(
    (s) =>
      ({
        ...s,
        label: reportLabel(w, s),
        measures: s.measures.map((m) => ({ ...m, label: reportLabel(w, m) })),
        dimensions: s.dimensions.map((d) => ({ ...d, label: reportLabel(w, d) })),
      }) as S,
  );
}
