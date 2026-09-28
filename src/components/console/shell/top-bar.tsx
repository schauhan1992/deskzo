"use client";

import Link from "next/link";
import { Bell, Menu, Search } from "lucide-react";
import { EnvBadge } from "@/components/console/kit/env-badge";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { IconButton } from "@/components/ui/icon-button";
import type { ConsoleRole, PlatformEnv } from "@/lib/console-shared/types";
import { cn } from "@/lib/utils";
import { useIsMac } from "./shortcuts-dialog";
import { StaffMenu } from "./staff-menu";

/** The bell's count, in the colour of the worst open alert. `text-surface` reads on the solid tone in both themes. */
const BUBBLE: Record<"danger" | "warning" | "info", string> = {
  danger: "bg-danger text-surface",
  warning: "bg-warning text-surface",
  info: "bg-info text-surface",
};

/**
 * The bar across the top of every console page (spec §1.4): on phones the navigation button, the
 * palette trigger, then which installation this is, the alerts bell, the theme (from `lg` up — below
 * that it is in the staff menu) and the staff menu.
 *
 * Nothing positioned `fixed` may live in here: the bar's backdrop blur makes it the containing block
 * for fixed descendants, so an overlay opened from inside it would be pinned to the bar. The palette,
 * the drawer and the dialogs are rendered by the shell; the staff menu's panel is portalled.
 */
export function TopBar({
  staff,
  env,
  alertsOpen,
  alertsTone = "danger",
  onOpenPalette,
  onOpenShortcuts,
  onOpenMobileNav,
}: {
  staff: { name: string; email: string; role: ConsoleRole };
  env: PlatformEnv;
  alertsOpen: number;
  /** The bubble's colour: danger with anything critical open, warning, or info when only notices are. */
  alertsTone?: "danger" | "warning" | "info";
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onOpenMobileNav: () => void;
}) {
  const mac = useIsMac();
  const alertsLabel = `Alerts, ${alertsOpen} open`;

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
      <IconButton icon={Menu} label="Open navigation" onClick={onOpenMobileNav} className="h-9 w-9 md:hidden" />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K /"
        className="flex h-9 w-full max-w-md min-w-0 items-center gap-2 rounded-base border border-line bg-surface-sunken px-3 text-sm text-subtle transition-colors hover:border-line-strong hover:text-muted"
      >
        <Search aria-hidden="true" className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search or jump to…</span>
        {/* "Ctrl K" from the server; a Mac says ⌘K once it has hydrated (useIsMac). */}
        <kbd aria-hidden="true" className="hidden shrink-0 rounded border border-line bg-surface px-1.5 font-mono text-[11px] leading-5 text-muted sm:inline">
          {mac ? "⌘K" : "Ctrl K"}
        </kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Production is the everyday case; on a phone its badge gives way to the controls. */}
        <span className={env.key === "production" ? "hidden sm:inline-flex" : "inline-flex"}>
          <EnvBadge env={env} />
        </span>
        <Link
          href="/alerts"
          aria-label={alertsLabel}
          title={alertsLabel}
          className="relative inline-grid h-9 w-9 shrink-0 place-items-center rounded-base text-subtle transition-colors duration-150 hover:bg-surface-sunken hover:text-brand"
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
          {alertsOpen > 0 && (
            <span
              aria-hidden="true"
              className={cn("absolute top-1 right-0.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold tabular-nums", BUBBLE[alertsTone])}
            >
              {alertsOpen > 99 ? "99+" : alertsOpen}
            </span>
          )}
        </Link>
        {/* Mounted at every width (only hidden below lg): it is what follows the OS while "System" is chosen. */}
        <div className="hidden lg:flex">
          <ThemeToggle defaultTheme="system" />
        </div>
        <StaffMenu staff={staff} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </header>
  );
}
