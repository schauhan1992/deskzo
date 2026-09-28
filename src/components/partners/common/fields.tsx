"use client";

import { useId, type HTMLAttributes, type ReactNode, type Ref } from "react";
import { CircleAlert } from "lucide-react";
import { Input, Label, Textarea } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * The partner portal's form fields (the CMS's, src/components/cms/common/fields.tsx, without its
 * site-link rules): a label that names the input, the input, and one line under it — the hint, or the
 * problem when there is one — with a character count against the same cap the server holds. The
 * problem is tied to the input by `aria-describedby` and marks it `aria-invalid`, so a screen reader
 * hears why the field is wrong when it lands on it.
 */

type FieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The server's cap; the count turns amber near it and red past it. */
  max?: number;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  readOnly?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  type?: "text" | "email" | "url" | "tel";
  inputMode?: HTMLAttributes<HTMLInputElement>["inputMode"];
  mono?: boolean;
  /** Visually hidden label (the row around it says what it is) — still read out. */
  srOnlyLabel?: boolean;
  autoComplete?: string;
};

function Counter({ length, max, id }: { length: number; max: number; id: string }) {
  const near = length > max * 0.9;
  const over = length > max;
  return (
    <span id={id} className={cn("shrink-0 text-[11px] tabular-nums", over ? "font-medium text-danger" : near ? "text-warning" : "text-subtle")}>
      {length.toLocaleString("en-IN")} / {max.toLocaleString("en-IN")}
      {over && <span className="sr-only"> — too long</span>}
    </span>
  );
}

function FieldFoot({ hint, error, hintId, count }: { hint?: ReactNode; error?: string | null; hintId: string; count?: ReactNode }) {
  if (!hint && !error && !count) return null;
  return (
    <div className="flex items-start justify-between gap-3">
      <p id={hintId} className={cn("min-w-0 text-xs", error ? "text-danger" : "text-muted")}>
        {error ? (
          <span className="inline-flex items-start gap-1">
            <CircleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0" />
            <span>{error}</span>
          </span>
        ) : (
          hint
        )}
      </p>
      {count}
    </div>
  );
}

function RequiredMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span aria-hidden="true" className="ml-0.5 text-danger">
      *
    </span>
  );
}

export function TextField({
  label,
  value,
  onChange,
  max,
  hint,
  error,
  required,
  readOnly,
  placeholder,
  id: givenId,
  className,
  inputRef,
  type = "text",
  inputMode,
  mono,
  srOnlyLabel,
  autoComplete = "off",
}: FieldProps) {
  const autoId = useId();
  const id = givenId ?? `${autoId}-field`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const showCount = max !== undefined && !readOnly;
  const describedBy = [hint || error ? hintId : null, showCount ? countId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id} className={srOnlyLabel ? "sr-only" : undefined}>
        {label}
        <RequiredMark show={!!required && !readOnly} />
      </Label>
      <Input
        ref={inputRef}
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        autoComplete={autoComplete}
        spellCheck={type === "text" && !mono}
        data-1p-ignore=""
        className={cn(mono && "font-mono text-[13px]", error && "border-danger", readOnly && "bg-surface-sunken text-muted")}
      />
      <FieldFoot hint={hint} error={error} hintId={hintId} count={showCount ? <Counter length={value.length} max={max!} id={countId} /> : undefined} />
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  max,
  hint,
  error,
  required,
  readOnly,
  placeholder,
  id: givenId,
  className,
  rows = 3,
}: Omit<FieldProps, "inputRef" | "type" | "inputMode" | "mono" | "srOnlyLabel" | "autoComplete"> & { rows?: number }) {
  const autoId = useId();
  const id = givenId ?? `${autoId}-field`;
  const hintId = `${id}-hint`;
  const countId = `${id}-count`;
  const showCount = max !== undefined && !readOnly;
  const describedBy = [hint || error ? hintId : null, showCount ? countId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        <RequiredMark show={!!required && !readOnly} />
      </Label>
      <Textarea
        id={id}
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(error && "border-danger", readOnly && "bg-surface-sunken text-muted")}
      />
      <FieldFoot hint={hint} error={error} hintId={hintId} count={showCount ? <Counter length={value.length} max={max!} id={countId} /> : undefined} />
    </div>
  );
}
