import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon";

const variantClasses: Record<Variant, string> = {
  primary: "bg-brand text-brand-contrast shadow-sm hover:brightness-110 active:brightness-95",
  secondary: "bg-surface text-text border border-line-strong shadow-sm hover:bg-surface-sunken",
  ghost: "text-muted hover:bg-surface-sunken hover:text-text",
  subtle: "bg-brand-subtle text-brand hover:brightness-105",
  danger: "bg-danger text-white shadow-sm hover:brightness-110 active:brightness-95",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-9 px-3.5 text-sm",
  icon: "h-9 w-9",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }
>(({ className, variant = "primary", size = "md", ...props }, ref) => (
  <button
    ref={ref}
    className={cn(
      "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-base font-medium",
      // A tiny press response makes the whole app feel less static.
      "transition-[background-color,color,box-shadow,filter,transform] duration-150 active:scale-[0.98]",
      "disabled:pointer-events-none disabled:opacity-45",
      variantClasses[variant],
      sizeClasses[size],
      className,
    )}
    {...props}
  />
));
Button.displayName = "Button";
