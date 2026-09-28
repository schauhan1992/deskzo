import type { ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from "lucide-react";
import type { Tone } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { TONE_BANNER } from "./status";

const ICONS: Record<Tone, LucideIcon> = {
  neutral: Info,
  info: Info,
  brand: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

/**
 * A state of the page worth reading before anything else on it — "Held since 3 Oct by Priya", "This
 * workspace pays through Stripe". The icon differs by tone as well as the colour, so the warning and
 * the danger banner are not told apart by colour alone. A danger banner is an alert (read out at
 * once); every other tone is a polite status.
 */
export function Banner({
  tone,
  title,
  children,
  action,
  icon,
  className,
}: {
  tone: Tone;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const Icon = ICONS[tone] ?? Info;
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border px-4 py-3 text-sm", TONE_BANNER[tone], className)}
    >
      <span aria-hidden="true" className="mt-0.5 inline-flex shrink-0">
        {icon ?? <Icon className="h-4 w-4" />}
      </span>
      <div className="min-w-48 flex-1">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 break-words">{children}</div>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2 self-center">{action}</div>}
    </div>
  );
}
