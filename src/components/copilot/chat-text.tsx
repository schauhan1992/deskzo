import Link from "next/link";
import { Fragment, type ReactNode } from "react";

/**
 * The copilot's words, with the little formatting it is told to use — paragraphs, bullets, bold,
 * italics, `code` — and record references turned into links. Built from React nodes, never HTML
 * strings: the text came from a model, and a model's output is not markup this page will render.
 */

const REF = /\b(COM|LEAD|ORD|TCK)-\d{6}\b/g;
const HREF: Record<string, string> = { COM: "/companies", LEAD: "/leads", ORD: "/orders", TCK: "/tickets" };

function inline(text: string, onNavigate?: () => void): ReactNode[] {
  // Bold, italic and code first, then references inside what is left.
  const out: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|(?<![\w*])[*_][^*_\n]+[*_](?![\w*]))/g;
  let last = 0;
  let key = 0;
  const withRefs = (s: string) => {
    const parts: ReactNode[] = [];
    let at = 0;
    for (const m of s.matchAll(REF)) {
      if (m.index! > at) parts.push(s.slice(at, m.index));
      parts.push(
        <Link key={`r${key++}`} href={`${HREF[m[1]!]}/${m[0]}`} onClick={onNavigate} className="font-mono text-[12px] text-brand underline-offset-2 hover:underline">
          {m[0]}
        </Link>,
      );
      at = m.index! + m[0].length;
    }
    if (at < s.length) parts.push(s.slice(at));
    return parts;
  };
  for (const m of text.matchAll(pattern)) {
    if (m.index! > last) out.push(...withRefs(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith("**")) out.push(<strong key={`b${key++}`}>{withRefs(token.slice(2, -2))}</strong>);
    else if (token.startsWith("`")) out.push(<code key={`c${key++}`} className="rounded bg-surface-sunken px-1 text-[12px]">{token.slice(1, -1)}</code>);
    else out.push(<em key={`i${key++}`}>{withRefs(token.slice(1, -1))}</em>);
    last = m.index! + token.length;
  }
  if (last < text.length) out.push(...withRefs(text.slice(last)));
  return out;
}

export function ChatText({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-text">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        const bullets = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (bullets) {
          const ordered = /^\s*\d/.test(lines[0] ?? "");
          const items = lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), onNavigate)}</li>);
          return ordered ? (
            <ol key={i} className="list-decimal space-y-0.5 pl-5">
              {items}
            </ol>
          ) : (
            <ul key={i} className="list-disc space-y-0.5 pl-5">
              {items}
            </ul>
          );
        }
        const heading = /^#{1,4}\s+/.test(block);
        return (
          <p key={i} className={heading ? "font-semibold" : undefined}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(heading ? l.replace(/^#{1,4}\s+/, "") : l, onNavigate)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
