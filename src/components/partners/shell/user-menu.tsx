"use client";

import { useTransition } from "react";
import { ChevronDown, Keyboard, LogOut, UserRound } from "lucide-react";
import { partnerSignOut } from "@/actions/partners/auth";
import { THEME_CHOICES, chooseTheme, useThemeChoice } from "@/components/layout/theme-toggle";
import { PartnerRolePill } from "@/components/partners/common/pills";
import { Avatar } from "@/components/ui/avatar";
import { PARTNER_ROUTES } from "@/lib/partners/nav";
import type { PartnerRole } from "@/lib/partners/types";
import { cn } from "@/lib/utils";
import { ShellMenu } from "./menu";

// The theme's choices, storage and event are the toggle's (src/components/layout/theme-toggle.tsx) —
// light and dark, nothing else; here they are menu radio items, because a menu's items must be.

/**
 * The signed-in person's menu at the right of the top bar: who they are (name, email, role, and the
 * partner they sign in for), My account, the keyboard shortcuts, the theme below `lg` (the bar has its
 * own toggle from there up), and signing out — which ends this session on the server and lands on /login.
 */
export function PartnerUserMenu({
  me,
  partnerName,
  onOpenShortcuts,
}: {
  me: { id: string; name: string; email: string; role: PartnerRole };
  partnerName: string;
  onOpenShortcuts: () => void;
}) {
  const theme = useThemeChoice("system");
  const [signingOut, startSignOut] = useTransition();

  return (
    <ShellMenu
      label={`Your account menu, ${me.name}`}
      width={272}
      triggerClassName={(open) => cn("flex h-9 min-w-0 items-center gap-2 rounded-base px-1.5 transition-colors hover:bg-surface-sunken", open && "bg-surface-sunken")}
      trigger={(open) => (
        <>
          <Avatar user={{ id: me.id, name: me.name }} size="sm" />
          <span className="hidden min-w-0 items-center gap-2 sm:flex">
            <span className="max-w-[10rem] truncate text-[13px] font-medium text-text">{me.name}</span>
            <PartnerRolePill role={me.role} />
          </span>
          <ChevronDown aria-hidden="true" className={cn("h-3.5 w-3.5 shrink-0 text-subtle transition-transform", open && "rotate-180")} />
        </>
      )}
      header={
        <>
          <p className="truncate text-sm font-medium text-text">{me.name}</p>
          <p translate="no" className="truncate text-xs text-muted">
            {me.email}
          </p>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5">
            <PartnerRolePill role={me.role} />
            <span className="truncate text-xs text-muted" title={partnerName}>
              {partnerName}
            </span>
          </div>
        </>
      }
      items={[
        { kind: "item", key: "account", label: "My account", icon: UserRound, href: PARTNER_ROUTES.account },
        { kind: "item", key: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, onSelect: onOpenShortcuts },
        { kind: "separator", key: "theme-rule", className: "lg:hidden" },
        {
          kind: "radios",
          key: "theme",
          label: "Theme",
          className: "lg:hidden",
          options: THEME_CHOICES.map(({ value, label, Icon }) => ({ value, label, icon: Icon, checked: theme === value, onSelect: () => chooseTheme(value) })),
        },
        { kind: "separator", key: "end" },
        {
          kind: "item",
          key: "sign-out",
          label: signingOut ? "Signing out…" : "Sign out",
          icon: LogOut,
          busy: signingOut,
          keepOpen: true,
          onSelect: () => startSignOut(() => partnerSignOut()),
        },
      ]}
    />
  );
}
