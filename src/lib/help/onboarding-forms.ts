import { checkLink } from "@/lib/help/links";

/**
 * The onboarding wizard's two small forms — one item, one help link — and what is wrong with each, in
 * words that say why. Pure: the wizard checks a field as it is left, and before anything is sent. The
 * actions behind them (`createItem`, `saveHelpLink`) check again, as they always have.
 */

export type ItemDraft = { name: string; sku: string; skuTyped: boolean; type: "GOOD" | "SERVICE"; price: string; tax: string };
export type ItemField = "name" | "sku" | "price" | "tax";
export const EMPTY_ITEM: ItemDraft = { name: "", sku: "", skuTyped: false, type: "SERVICE", price: "", tax: "18" };

export type HelpDraft = { kind: "ARTICLE" | "VIDEO"; title: string; url: string };
export type HelpField = "title" | "url";
export const EMPTY_HELP: HelpDraft = { kind: "ARTICLE", title: "", url: "" };

/** Nothing typed yet — there is nothing to save, and the step is either done already or to be skipped. */
export const itemDraftEmpty = (d: ItemDraft) => !d.name.trim() && !d.price.trim() && !(d.skuTyped && d.sku.trim());
export const helpDraftEmpty = (d: HelpDraft) => !d.title.trim() && !d.url.trim();

/** A SKU made from the name until somebody types their own: "Annual support plan" → "ANNUAL-SUPPORT-PLAN". */
export function skuFrom(name: string): string {
  const words = name.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  return words.join("-").slice(0, 24).replace(/-+$/, "");
}

export function itemProblem(field: ItemField, d: ItemDraft): string | null {
  switch (field) {
    case "name": {
      const name = d.name.trim();
      if (!name) return "Give it a name — the one your customers know it by.";
      return name.length < 2 ? "A name needs at least 2 characters." : null;
    }
    case "sku":
      return d.sku.trim() ? null : "Give it a SKU — a short code of your own, like MS365-BSTD.";
    case "price": {
      const raw = d.price.trim();
      if (!raw) return "Enter the selling price — 0 is fine for something you give away.";
      const n = Number(raw);
      if (!Number.isFinite(n)) return "The price is a number — digits and a decimal point only, no currency sign.";
      return n < 0 ? "The price can't be below zero." : null;
    }
    case "tax": {
      const raw = d.tax.trim();
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 100 ? null : "A tax rate is a percentage from 0 to 100.";
    }
  }
}

export function itemIssues(d: ItemDraft): Partial<Record<ItemField, string>> {
  const issues: Partial<Record<ItemField, string>> = {};
  for (const field of ["name", "sku", "price", "tax"] as const) {
    const problem = itemProblem(field, d);
    if (problem) issues[field] = problem;
  }
  return issues;
}

export function helpProblem(field: HelpField, d: HelpDraft): string | null {
  if (field === "title") {
    const title = d.title.trim();
    if (!title) return "Give it a title people will recognise in the Help panel.";
    return title.length > 120 ? `Keep the title to 120 characters — this one has ${title.length}.` : null;
  }
  if (!d.url.trim()) return d.kind === "VIDEO" ? "Paste the video's link — a YouTube link works." : "Paste the article's link — https://…, or a page in the app starting with /.";
  const link = checkLink(d.url);
  return link.ok ? null : link.error;
}

export function helpIssues(d: HelpDraft): Partial<Record<HelpField, string>> {
  const issues: Partial<Record<HelpField, string>> = {};
  for (const field of ["title", "url"] as const) {
    const problem = helpProblem(field, d);
    if (problem) issues[field] = problem;
  }
  return issues;
}
