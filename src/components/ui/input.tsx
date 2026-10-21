import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes, type SelectHTMLAttributes } from "react";
import { DateField } from "@/components/ui/date-field";
import { cn } from "@/lib/utils";

const fieldClasses = cn(
  "flex h-9 w-full rounded-base border border-line-strong bg-surface px-3 text-sm text-text",
  "placeholder:text-subtle shadow-sm transition-[border-color,box-shadow] duration-150",
  // Keyboard focus keeps the global outline rather than cancelling it; the border tint is kept as
  // a secondary cue, not as the only one. `focus-visible` rather than `focus` so a mouse click does
  // not draw a ring nobody asked for.
  "focus-visible:border-brand",
  "disabled:cursor-not-allowed disabled:opacity-55 disabled:bg-surface-sunken",
);

const opensCalendar = (type: string | undefined): type is "date" | "datetime-local" | "month" =>
  type === "date" || type === "datetime-local" || type === "month";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, type, ...props }, ref) =>
  // A date, a date and time, or a month opens the app's own calendar (owner, 19 Oct 2026), not the
  // browser's: still the same input underneath, so forms, react-hook-form and `onChange` don't notice.
  opensCalendar(type) ? (
    <DateField ref={ref} type={type} className={cn(fieldClasses, className)} {...props} />
  ) : (
    <input ref={ref} type={type} className={cn(fieldClasses, className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClasses, "h-auto min-h-20 py-2 leading-relaxed", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClasses, "cursor-pointer pr-8", className)} {...props}>
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-[13px] font-medium text-muted", className)} {...props} />;
}
