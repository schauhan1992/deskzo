"use client";

import { useId } from "react";
import { TriangleAlert } from "lucide-react";
import { useIssuesAt } from "@/components/cms/editor/editor-context";
import { Input } from "@/components/ui/input";
import { KEYWORD_MAX_LENGTH, MAX_KEYWORDS } from "@/lib/seo/keywords";
import { cn } from "@/lib/utils";

/**
 * The three primary keywords of a page, post, category or tag: "Primary keyword 1", "2" and "3",
 * bound to `seo.keywords[0..2]` — the paths the server's issues use, so a refusal lands in the box it
 * is about. A blank box is fine (the list is kept box for box while editing, and the server stores
 * it without blanks); a repeat, a comma or an over-long one is marked as you type, in the words of
 * `keywordProblems` (src/lib/seo/keywords.ts), which the server checks with too. Each is trimmed
 * when you leave it.
 */

export const KEYWORD_HINT = "Up to three phrases this page should be found for. Used for placement analysis and the keywords tag — not a ranking factor.";

const blank = (s: string | undefined) => !s || !s.trim();

/** The boxes' values from the stored list: always three. */
export function keywordSlots(value: readonly string[] | undefined): string[] {
  return Array.from({ length: MAX_KEYWORDS }, (_, i) => value?.[i] ?? "");
}

/** The list the draft keeps: box for box, trailing blanks dropped; none at all is no list. */
export function keywordsFromSlots(slots: readonly string[]): string[] | undefined {
  const list = [...slots];
  while (list.length && blank(list[list.length - 1])) list.pop();
  return list.length ? list : undefined;
}

function KeywordBox({
  index,
  value,
  onChange,
  onCommit,
  extra,
  readOnly,
}: {
  index: number;
  value: string;
  onChange: (next: string) => void;
  onCommit: (next: string) => void;
  extra: string[];
  readOnly: boolean;
}) {
  const id = useId();
  const fromIssues = useIssuesAt(`keywords[${index}]`);
  const messages = [...new Set([...extra, ...fromIssues])];
  const over = value.trim().length > KEYWORD_MAX_LENGTH;
  return (
    <div data-field-path={`seo.keywords[${index}]`} className="min-w-0 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-muted">
          {`Primary keyword ${index + 1}`}
          <span className="font-normal text-subtle"> (optional)</span>
        </label>
        <span id={`${id}-count`} className={cn("shrink-0 text-[11px] tabular-nums", over ? "font-medium text-danger" : "text-subtle")}>
          {`${value.trim().length}/${KEYWORD_MAX_LENGTH}`}
          <span className="sr-only"> characters</span>
        </span>
      </div>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => {
          const trimmed = e.target.value.trim();
          if (trimmed !== e.target.value) onCommit(trimmed);
        }}
        readOnly={readOnly}
        spellCheck
        autoComplete="off"
        data-1p-ignore=""
        placeholder={index === 0 ? "GST invoicing software" : undefined}
        aria-invalid={messages.length ? true : undefined}
        aria-describedby={[`${id}-count`, messages.length ? `${id}-err` : ""].filter(Boolean).join(" ")}
        className={cn(messages.length > 0 && "border-danger")}
      />
      {messages.length > 0 && (
        <ul id={`${id}-err`} className="space-y-0.5">
          {messages.map((m) => (
            <li key={m} className="flex items-start gap-1 text-xs text-danger">
              <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
              {m}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The three boxes, under a legend. Inside an editor's `IssueScope prefix="seo"` their issues come from
 * the editor's own check; the term dialog passes `problems` (its own check, and the server's).
 */
export function KeywordFields({
  value,
  onChange,
  problems,
  readOnly = false,
  columns = 1,
  hint = KEYWORD_HINT,
}: {
  value: readonly string[] | undefined;
  onChange: (next: string[] | undefined) => void;
  /** Messages for box `index`, beyond the editor's issue scope. */
  problems?: (index: number) => string[];
  readOnly?: boolean;
  columns?: 1 | 3;
  hint?: string;
}) {
  const hintId = useId();
  const slots = keywordSlots(value);
  const listMessages = useIssuesAt("keywords");
  const set = (index: number, next: string) => onChange(keywordsFromSlots(slots.map((s, i) => (i === index ? next : s))));
  return (
    <fieldset data-field-path="seo.keywords" aria-describedby={hintId} className="min-w-0 space-y-2">
      <legend className="text-[13px] font-semibold text-text">Primary keywords</legend>
      <p id={hintId} className="text-xs text-subtle">
        {hint}
      </p>
      <div className={cn("grid gap-3", columns === 3 && "sm:grid-cols-3")}>
        {slots.map((slot, i) => (
          <KeywordBox key={i} index={i} value={slot} onChange={(next) => set(i, next)} onCommit={(next) => set(i, next)} extra={problems?.(i) ?? []} readOnly={readOnly} />
        ))}
      </div>
      {listMessages.map((m) => (
        <p key={m} className="flex items-start gap-1 text-xs text-danger">
          <TriangleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
          {m}
        </p>
      ))}
    </fieldset>
  );
}
