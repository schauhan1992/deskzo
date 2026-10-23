"use client";

import { useRef, useState } from "react";
import { Check, CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { CALC_FORMATS, LIMITS, type CalcFormat, type CalculatedField } from "@/lib/reporting/definition";
import { expressionText, parseExpression } from "@/lib/reporting/expression";
import type { CatalogMeasure } from "@/lib/reporting/sources";
import { FieldMark } from "./controls";

const FORMAT_LABELS: Record<CalcFormat, string> = { currency: "Rupees", number: "Number", percent: "Percentage" };

/**
 * A calculated field: arithmetic over the source's metrics, checked as it is typed by the same parser the server
 * checks it with again (src/lib/reporting/expression.ts) — never run as code. Worked out on each bucket's totals,
 * so "collection rate" is received ÷ invoiced for the month, not an average of each invoice's rate.
 */
export function CalcDialog({
  measures,
  field,
  onSave,
  onDelete,
  onClose,
}: {
  measures: CatalogMeasure[];
  field: CalculatedField | null;
  onSave: (field: CalculatedField) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(field?.label ?? "");
  const [expression, setExpression] = useState(field?.expression ?? "");
  const [format, setFormat] = useState<CalcFormat>(field?.format ?? "number");
  const [touched, setTouched] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const known = new Set(measures.map((m) => m.key));
  const parsed = expression.trim() ? parseExpression(expression, known) : null;
  const labelOf = (key: string) => measures.find((m) => m.key === key)?.label;

  function insert(text: string) {
    const el = box.current;
    const at = el?.selectionStart ?? expression.length;
    const end = el?.selectionEnd ?? at;
    const next = `${expression.slice(0, at)}${text}${expression.slice(end)}`;
    setExpression(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  }

  const problem = !label.trim() ? "Name the calculated field." : !parsed ? "Write the calculation." : !parsed.ok ? parsed.error : null;

  return (
    <Dialog open onClose={onClose} title={field ? "Edit calculated field" : "New calculated field"}>
      <div className="space-y-3">
        <label className="block text-[12.5px] font-medium text-text">
          Name
          <input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="Collection rate" className="mt-1 h-9 w-full rounded-lg border border-line bg-surface px-2.5 text-[13px] font-normal text-text" />
        </label>
        <div>
          <label htmlFor="calc-expression" className="block text-[12.5px] font-medium text-text">
            Calculation
          </label>
          <textarea
            id="calc-expression"
            ref={box}
            value={expression}
            maxLength={LIMITS.expression}
            onChange={(e) => setExpression(e.target.value)}
            onBlur={() => setTouched(true)}
            rows={3}
            spellCheck={false}
            placeholder="{received} / {net}"
            className={cn("mt-1 w-full rounded-lg border bg-surface px-2.5 py-2 font-mono text-[13px] text-text outline-none", parsed && !parsed.ok && touched ? "border-danger" : "border-line focus:border-brand")}
          />
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {measures.map((m) => (
              <button key={m.key} type="button" onClick={() => insert(`{${m.key}}`)} className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-[12px] text-text hover:border-brand hover:text-brand">
                <FieldMark type={m.type} />
                {m.label}
              </button>
            ))}
            {["+", "−", "×", "÷", "(", ")"].map((op) => (
              <button key={op} type="button" onClick={() => insert(` ${op} `.replace("( ", "(").replace(" )", ")"))} className="h-7 w-7 rounded-full border border-line font-mono text-[13px] text-text hover:border-brand hover:text-brand">
                {op}
              </button>
            ))}
          </div>
          <div className="mt-2 min-h-[20px] text-[12.5px]">
            {parsed?.ok ? (
              <p className="flex items-start gap-1.5 text-success">
                <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Reads as <span className="text-text">{expressionText(expression, labelOf)}</span> — worked out on each group&apos;s totals.
                </span>
              </p>
            ) : parsed && touched ? (
              <p className="flex items-start gap-1.5 text-danger" role="alert">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {parsed.error}
              </p>
            ) : (
              <p className="text-subtle">Metrics in braces, numbers, + − × ÷ and brackets. Nothing else is accepted.</p>
            )}
          </div>
        </div>
        <div>
          <p className="text-[12.5px] font-medium text-text">Show as</p>
          <div className="mt-1 flex gap-0.5 rounded-lg bg-surface-sunken p-[3px]">
            {CALC_FORMATS.map((f) => (
              <button key={f} type="button" aria-pressed={format === f} onClick={() => setFormat(f)} className={cn("h-8 flex-1 rounded-md text-[13px] font-medium", format === f ? "bg-surface text-text shadow-sm" : "text-muted")}>
                {FORMAT_LABELS[f]}
              </button>
            ))}
          </div>
          {format === "percent" && <p className="mt-1 text-[12px] text-subtle">A ratio of 0.79 shows as 79.0%.</p>}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          {onDelete ? (
            <button type="button" onClick={onDelete} className="text-[13px] font-medium text-danger hover:underline">
              Delete field
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!!problem}
              title={problem ?? undefined}
              onClick={() => onSave({ id: field?.id ?? `c${Date.now().toString(36)}`, label: label.trim(), expression: expression.trim(), format })}
            >
              {field ? "Save field" : "Add field"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
