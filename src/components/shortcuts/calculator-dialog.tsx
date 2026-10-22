"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { calculate, formatCalc } from "@/lib/shortcuts/calc";

/**
 * F10 — BUSY's calculator (src/lib/shortcuts/calc.ts). Enter works the sum out and keeps the answer to carry on
 * from; the last few answers stay under it. "Copy" puts the answer on the clipboard, plain, to paste into a field.
 */
export function CalculatorDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [expr, setExpr] = useState("");
  const [tape, setTape] = useState<{ expr: string; value: number }[]>([]);
  const result = expr.trim() ? calculate(expr) : null;
  const inputRef = useRef<HTMLInputElement>(null);
  // The dialog puts focus on its first control, the close button; the box is where a keyboard person types.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function work() {
    if (!result?.ok) return;
    setTape((t) => [{ expr, value: result.value }, ...t].slice(0, 6));
    setExpr(String(result.value));
  }

  function copy(value: number) {
    void navigator.clipboard?.writeText(String(value)).catch(() => {});
  }

  return (
    <Dialog open={open} onClose={onClose} title="Calculator">
      <input
        ref={inputRef}
        value={expr}
        onChange={(e) => setExpr(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            work();
          }
        }}
        inputMode="decimal"
        placeholder="1,25,000 × 18% + 500"
        aria-label="Sum"
        className="h-11 w-full rounded-base border border-line-strong bg-surface px-3 text-right font-mono text-lg text-text placeholder:text-subtle focus-visible:border-brand"
      />
      <div aria-live="polite" className="mt-2 flex min-h-8 items-center justify-between gap-3">
        {result === null ? (
          <span className="text-xs text-subtle">+ − × ÷, brackets, and % — Enter works it out.</span>
        ) : result.ok ? (
          <>
            <span className="font-mono text-xl font-semibold text-text">= {formatCalc(result.value)}</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(result.value)}>
              Copy
            </Button>
          </>
        ) : (
          <span className="text-xs text-danger">{result.error}</span>
        )}
      </div>
      {tape.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-line pt-2 text-sm">
          {tape.map((t, i) => (
            <li key={i} className="flex items-center justify-between gap-3">
              <button type="button" onClick={() => setExpr(t.expr)} className="min-w-0 truncate text-left font-mono text-xs text-muted hover:text-text">
                {t.expr}
              </button>
              <button type="button" onClick={() => copy(t.value)} title="Copy" className="shrink-0 font-mono text-text hover:underline">
                {formatCalc(t.value)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
