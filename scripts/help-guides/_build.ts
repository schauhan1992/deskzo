import type { RichInline, RichNode } from "../../src/components/site/blocks/types";

/**
 * Small builders for the guide drafts, so each file reads as words rather than JSON. The same shapes
 * the website seed's builders make (scripts/site-content/_build.ts), with the guide's own additions.
 */

export const p = (text: RichInline): RichNode => ({ type: "paragraph", text });
export const h3 = (text: string): RichNode => ({ type: "heading", level: 3, text });
export const ul = (...items: RichInline[]): RichNode => ({ type: "list", items });
/** Numbered steps. */
export const ol = (...items: RichInline[]): RichNode => ({ type: "list", ordered: true, items });
export const table = (columns: string[], rows: RichInline[][]): RichNode => ({ type: "table", columns, rows });
export const note = (text: RichInline, tone: "info" | "warning" = "info"): RichNode => ({ type: "note", tone, text });

/**
 * Inline runs: a string is plain text, `{ b: "New lead" }` bold (a button, a field, a menu item — the
 * words on the screen, exactly), `{ i: "…" }` italic, `[words, "/help/orders"]` a link (to another
 * guide, or a page on the site).
 */
export function runs(...parts: (string | { b: string } | { i: string } | [string, string])[]): RichInline {
  return parts.map((part) =>
    typeof part === "string" ? { text: part } : Array.isArray(part) ? { text: part[0], href: part[1] } : "b" in part ? { text: part.b, strong: true } : { text: part.i, em: true },
  );
}

/** A task: its title and what is under it, steps and all. */
export const task = (title: string, ...body: RichNode[]) => ({ title, body });
/** A setting: its name as the screen labels it, where it is ("Settings › Pipeline"), and what it changes. */
export const setting = (name: string, where: string | undefined, ...body: RichNode[]) => ({ name, ...(where ? { where } : {}), body });
/** A question and its answer. */
export const qa = (question: string, ...answer: RichNode[]) => ({ question, answer });
/** A permission (a src/lib/permissions.ts key) and what holding it lets somebody do, in plain words. */
export const perm = (key: string, text: string) => ({ key, text });
