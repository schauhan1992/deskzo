"use client";

import { ArrowUpRight, Globe, Menu } from "lucide-react";
import { EnvBadge } from "@/components/console/kit/env-badge";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { PartnerKindPill } from "@/components/partners/common/pills";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import type { PlatformEnv } from "@/lib/console-shared/types";
import type { PartnerKind, PartnerRole } from "@/lib/partners/types";
import { PartnerUserMenu } from "./user-menu";

/**
 * The bar across the top of every portal page: on phones the navigation button; whose portal this
 * is (the partner's display name and whether it is a distributor or a reseller); the public site, one
 * click away in a new tab; which installation this is; the theme (from `lg` — below that it is in the
 * user menu); and the user menu.
 *
 * Nothing positioned `fixed` may live in here: the bar's backdrop blur makes it the containing block
 * for fixed descendants. Menus are portalled (`AnchoredPopover`), dialogs too (`Dialog`), and the
 * drawer is the shell's.
 */
export function PartnerTopBar({
  me,
  partner,
  env,
  site,
  onOpenMobileNav,
  onOpenShortcuts,
}: {
  me: { id: string; name: string; email: string; role: PartnerRole };
  partner: { displayName: string; kind: PartnerKind };
  env: PlatformEnv;
  site: { url: string; host: string; name: string };
  onOpenMobileNav: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
      <IconButton icon={Menu} label="Open navigation" onClick={onOpenMobileNav} className="h-9 w-9 md:hidden" />

      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-semibold text-text" title={partner.displayName}>
          {partner.displayName}
        </span>
        <span className="hidden shrink-0 sm:inline-flex">
          <PartnerKindPill kind={partner.kind} />
        </span>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <OutboundLink
          href={site.url}
          title={site.host}
          className="group hidden h-8 items-center gap-1.5 rounded-base border border-line bg-surface px-2.5 text-[13px] font-medium text-text shadow-sm transition-colors hover:border-line-strong hover:bg-surface-sunken md:inline-flex"
        >
          <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle group-hover:text-brand" />
          <span className="max-w-[12rem] truncate">{site.name}</span>
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
          <span className="sr-only"> website (opens in a new tab)</span>
        </OutboundLink>
        <span className={env.key === "production" ? "hidden sm:inline-flex" : "inline-flex"}>
          <EnvBadge env={env} />
        </span>
        <div className="hidden lg:flex">
          <ThemeToggle defaultTheme="system" />
        </div>
        <PartnerUserMenu me={me} partnerName={partner.displayName} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </header>
  );
}
