"use client";

import { ArrowUpRight, Globe, Menu } from "lucide-react";
import { EnvBadge } from "@/components/console/kit/env-badge";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { IconButton } from "@/components/ui/icon-button";
import { OutboundLink } from "@/components/ui/outbound-link";
import type { PlatformEnv } from "@/lib/console-shared/types";
import type { CmsCaps, CmsRole } from "@/lib/cms/types";
import { NewMenu } from "./new-menu";
import { CmsUserMenu } from "./user-menu";

/**
 * The bar across the top of every CMS page: on phones the navigation button; the public site, one
 * click away in a new tab; which installation this is; "New" for the roles that may make things; the
 * theme (from `lg` — below that it is in the user menu); and the user menu.
 *
 * Nothing positioned `fixed` may live in here: the bar's backdrop blur makes it the containing block
 * for fixed descendants. Menus are portalled (`AnchoredPopover`), dialogs too (`Dialog`), and the
 * drawer is the shell's.
 */
export function CmsTopBar({
  me,
  env,
  caps,
  site,
  onOpenMobileNav,
  onOpenShortcuts,
}: {
  me: { id: string; name: string; email: string; role: CmsRole };
  env: PlatformEnv;
  caps: CmsCaps;
  site: { url: string; host: string };
  onOpenMobileNav: () => void;
  onOpenShortcuts: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:px-6">
      <IconButton icon={Menu} label="Open navigation" onClick={onOpenMobileNav} className="h-9 w-9 md:hidden" />

      <OutboundLink
        href={site.url}
        className="group inline-flex h-8 min-w-0 items-center gap-2 rounded-base border border-line bg-surface px-2.5 text-[13px] font-medium text-text shadow-sm transition-colors hover:border-line-strong hover:bg-surface-sunken"
      >
        <Globe aria-hidden="true" className="h-4 w-4 shrink-0 text-subtle group-hover:text-brand" />
        <span className="shrink-0">View site</span>
        <span translate="no" className="hidden min-w-0 truncate font-mono text-xs font-normal text-muted md:inline">
          {site.host}
        </span>
        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <span className="sr-only"> (opens in a new tab)</span>
      </OutboundLink>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span className={env.key === "production" ? "hidden sm:inline-flex" : "inline-flex"}>
          <EnvBadge env={env} />
        </span>
        {caps.write && <NewMenu siteHost={site.host} />}
        <div className="hidden lg:flex">
          <ThemeToggle defaultTheme="system" />
        </div>
        <CmsUserMenu me={me} onOpenShortcuts={onOpenShortcuts} />
      </div>
    </header>
  );
}
