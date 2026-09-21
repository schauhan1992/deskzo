import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface shadow-sm",
        "transition-shadow duration-200 hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-line px-5 py-3.5", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...props} />;
}

type Tone = "default" | "green" | "blue" | "red" | "amber" | "brand";

/**
 * Status colours come from the semantic tokens, so they stay legible in dark mode instead of
 * being pale tints designed only for a white background.
 */
const tones: Record<Tone, string> = {
  default: "bg-surface-sunken text-muted border-line",
  green: "bg-success-bg text-success border-transparent",
  blue: "bg-info-bg text-info border-transparent",
  red: "bg-danger-bg text-danger border-transparent",
  amber: "bg-warning-bg text-warning border-transparent",
  brand: "bg-brand-subtle text-brand border-transparent",
};

export function Badge({
  className,
  tone = "default",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5 whitespace-nowrap",
        tones[tone],
        className,
      )}
      {...props}
    />
  );
}
