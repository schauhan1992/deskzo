import type { RichInline, RichSpan } from "@/components/site/blocks/types";

/**
 * Rich text runs (`RichInline`: plain text, or runs of it that are bold, italic or a link), written
 * and read as a tiny markup an editor can type into an ordinary text box:
 *
 *   **bold**   *italic*   [the words](/pricing)   \* for a literal asterisk
 *
 * Nothing here is HTML and nothing becomes HTML: the markup is parsed back into the same structured
 * runs the site renders through React (src/components/site/blocks/rich-text.tsx), and a link is only
 * ever a link once it passes the site's own check.
 *
 * `serializeInline` then `parseInline` gives back the same runs (adjacent runs with the same look are
 * merged, which renders identically). A marker that is never closed stays as the characters typed, so
 * half-typed text is never lost or reinterpreted.
 */

const ESCAPABLE = /[\\*[\]]/g;

function escapeText(text: string): string {
  return text.replace(ESCAPABLE, (c) => `\\${c}`);
}

/** Leading and trailing spaces go outside the markers: "** bold**" would not read back as bold. */
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function spanToMarkup(span: RichSpan): string {
  if (!span.text) return "";
  let out = escapeText(span.text);
  if (span.href) out = `[${out}](${span.href.replace(/\)/g, "%29").replace(/\s/g, "%20")})`;
  if (span.em) out = wrap(out, "*");
  if (span.strong) out = wrap(out, "**");
  return out;
}

export function serializeInline(value: RichInline | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return escapeText(value);
  return value.map(spanToMarkup).join("");
}

/** Whether an unescaped `marker` appears at or after `from`. */
function hasCloser(src: string, from: number, marker: "*" | "**"): boolean {
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c !== "*") continue;
    if (marker === "**") {
      if (src[i + 1] === "*") return true;
    } else {
      return true;
    }
  }
  return false;
}

/** `[text](href)` starting at `start`, or null. The text may hold escapes, not brackets; the address holds no spaces. */
function matchLink(src: string, start: number): { text: string; href: string; end: number } | null {
  let text = "";
  let i = start + 1;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      text += src[i + 1];
      i++;
      continue;
    }
    if (c === "[") return null;
    if (c === "]") break;
    text += c;
  }
  if (src[i] !== "]" || src[i + 1] !== "(") return null;
  const close = src.indexOf(")", i + 2);
  if (close < 0) return null;
  const href = src.slice(i + 2, close);
  if (!href || /\s/.test(href) || !text) return null;
  return { text, href, end: close + 1 };
}

const sameLook = (a: RichSpan, b: RichSpan) => !a.href && !b.href && !!a.strong === !!b.strong && !!a.em === !!b.em;

export function parseInline(src: string): RichInline {
  const spans: RichSpan[] = [];
  let strong = false;
  let em = false;
  let buffer = "";

  const push = (span: RichSpan) => {
    if (!span.text) return;
    const clean: RichSpan = { text: span.text };
    if (span.strong) clean.strong = true;
    if (span.em) clean.em = true;
    if (span.href) clean.href = span.href;
    const last = spans[spans.length - 1];
    if (last && sameLook(last, clean)) last.text += clean.text;
    else spans.push(clean);
  };
  const flush = () => {
    push({ text: buffer, strong, em });
    buffer = "";
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      buffer += src[i + 1];
      i++;
      continue;
    }
    if (c === "*") {
      const double = src[i + 1] === "*";
      const marker = double ? "**" : "*";
      const after = src[i + marker.length];
      const on = double ? strong : em;
      // An opening marker must be followed by text (so "2 * 3" stays as typed) and closed later on.
      const opens = !on && after !== undefined && !/\s/.test(after) && hasCloser(src, i + marker.length, marker);
      if (on || opens) {
        flush();
        if (double) strong = !strong;
        else em = !em;
        i += marker.length - 1;
        continue;
      }
      buffer += marker;
      i += marker.length - 1;
      continue;
    }
    if (c === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        push({ text: link.text, strong, em, href: link.href });
        i = link.end - 1;
        continue;
      }
    }
    buffer += c;
  }
  flush();

  if (spans.length === 0) return "";
  if (spans.length === 1 && !spans[0].strong && !spans[0].em && !spans[0].href) return spans[0].text;
  return spans;
}

/** The runs' text alone, for a summary line or a character count. */
export function plainInline(value: RichInline | null | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : value.map((s) => s.text).join("");
}
