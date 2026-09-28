import type { SiteBlock } from "@/components/site/blocks/types";
import type { CmsIssue } from "@/lib/cms/types";

/**
 * Small, pure helpers the block editor is built on: immutable list moves, fresh block ids, and
 * turning the server's issue paths ("blocks[2].props.items[0].title") into something a block's form
 * can show next to the field it is about.
 */

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function insertItem<T>(list: readonly T[], index: number, item: T): T[] {
  const next = [...list];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, item);
  return next;
}

export function removeItem<T>(list: readonly T[], index: number): T[] {
  return list.filter((_, i) => i !== index);
}

export function replaceItem<T>(list: readonly T[], index: number, item: T): T[] {
  return list.map((existing, i) => (i === index ? item : existing));
}

/** A block id the validator keeps: lower-case letters and digits. Called from event handlers only. */
export function newBlockId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

/** A deep copy with a new id — for "Duplicate". */
export function cloneBlock(block: SiteBlock): SiteBlock {
  return { ...structuredClone(block), id: newBlockId() };
}

/** A relative issue: its path below the block's props ("items[0].title"), and what is wrong. */
export type FieldIssue = { path: string; message: string };

/**
 * The issues of a document sorted by block — by `blockId` when the server gave one, otherwise by the
 * index in the path — each re-rooted below the block's props. What belongs to no block (a page's
 * title, its SEO, "add at least one block") comes back as `document`.
 */
export function groupIssues(issues: readonly CmsIssue[], blocks: readonly SiteBlock[], root: "blocks" | "body"): { byBlock: Map<string, FieldIssue[]>; document: CmsIssue[] } {
  const byBlock = new Map<string, FieldIssue[]>();
  const document: CmsIssue[] = [];
  const ids = new Set(blocks.map((b) => b.id));
  const prefix = new RegExp(`^${root}\\[(\\d+)\\](?:\\.props)?\\.?`);
  for (const issue of issues) {
    const match = prefix.exec(issue.path);
    let blockId = issue.blockId && ids.has(issue.blockId) ? issue.blockId : null;
    if (!blockId && match) blockId = blocks[Number(match[1])]?.id ?? null;
    if (!blockId) {
      document.push(issue);
      continue;
    }
    const path = match ? issue.path.slice(match[0].length) : issue.path;
    const list = byBlock.get(blockId) ?? [];
    list.push({ path, message: issue.message });
    byBlock.set(blockId, list);
  }
  return { byBlock, document };
}

/** One list of issues without repeats (the same field and message from the browser's check and the server's). */
export function mergeIssues(...lists: readonly CmsIssue[][]): CmsIssue[] {
  const seen = new Set<string>();
  const out: CmsIssue[] = [];
  for (const list of lists) {
    for (const issue of list) {
      const key = `${issue.path}|${issue.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(issue);
    }
  }
  return out;
}

const WORDS: Record<string, string> = {
  props: "",
  items: "item",
  groups: "group",
  modules: "module",
  content: "part",
  rows: "row",
  columns: "column",
  aside: "side note",
  bullets: "bullet",
  body: "paragraph",
  answer: "answer paragraph",
  asideItems: "point",
  blocks: "block",
};

/** "items[2].link.href" → "Item 3 › link › href" — a readable place for an issue in a summary list. */
export function describePath(path: string): string {
  if (!path) return "This block";
  const parts: string[] = [];
  for (const segment of path.split(".")) {
    const m = /^([A-Za-z]+)((?:\[\d+\])*)$/.exec(segment);
    if (!m) {
      parts.push(segment);
      continue;
    }
    const [, name, indexes] = m;
    const numbers = [...indexes.matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]) + 1);
    const word = WORDS[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    if (!word && !numbers.length) continue;
    parts.push(numbers.length ? `${word || name} ${numbers.join(".")}` : word);
  }
  const text = parts.filter(Boolean).join(" › ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
