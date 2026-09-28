"use client";

/**
 * A field people never see and bots fill in: the actions treat a filled one as a bot, and give it the
 * normal answer and nothing else. Hidden from sight and from assistive technology, out of the tab
 * order, never autofilled — and still labelled, like every field (check:a11y).
 */
export function Honeypot({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  return (
    <div aria-hidden="true" className="sr-only">
      <label htmlFor={id}>Website (leave this empty)</label>
      <input id={id} name="website" type="text" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
