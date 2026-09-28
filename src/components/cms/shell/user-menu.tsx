"use client";

import { useTransition } from "react";
import { ChevronDown, Keyboard, LogOut, Moon, Sun, UserRound } from "lucide-react";
import { chooseTheme, useThemeChoice } from "@/components/layout/theme-toggle";
import { cmsSignOut } from "@/actions/cms/auth";
import { CmsRolePill } from "@/components/cms/common/status";
import { Avatar } from "@/components/ui/avatar";
import { CMS_ROUTES } from "@/lib/cms/nav";
import type { CmsRole } from "@/lib/cms/types";
import { cn } from "@/lib/utils";
import { ShellMenu } from "./menu";

// The theme's choice, storage and event are the toggle's (src/components/layout/theme-toggle.tsx);
// here they are menu radio items, because a menu's items must be.

/**
 * The signed-in person's menu at the right of the top bar: who they are (name, email, role), My
 * account, the keyboard shortcuts, the theme below `lg` (the bar has its own toggle from there up),
 * and signing out — which ends this session on the server and lands on /login.
 */
export function CmsUserMenu({ me, onOpenShortcuts }: { me: { id: string; name: string; email: string; role: CmsRole }; onOpenShortcuts: () => void }) {
  const theme = useThemeChoice("system");
  const [signingOut, startSignOut] = useTransition();

  return (
    <ShellMenu
      label={`Your account menu, ${me.name}`}
      width={264}
      triggerClassName={(open) => cn("flex h-9 min-w-0 items-center gap-2 rounded-base px-1.5 transition-colors hover:bg-surface-sunken", open && "bg-surface-sunken")}
      trigger={(open) => (
        <>
          <Avatar user={{ id: me.id, name: me.name }} size="sm" />
          <span className="hidden min-w-0 items-center gap-2 sm:flex">
            <span className="max-w-[10rem] truncate text-[13px] font-medium text-text">{me.name}</span>
            <CmsRolePill role={me.role} />
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
          <div className="mt-1.5">
            <CmsRolePill role={me.role} />
          </div>
        </>
      }
      items={[
        { kind: "item", key: "account", label: "My account", icon: UserRound, href: CMS_ROUTES.account },
        { kind: "item", key: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, onSelect: onOpenShortcuts },
        { kind: "separator", key: "theme-rule", className: "lg:hidden" },
        {
          kind: "radios",
          key: "theme",
          label: "Theme",
          className: "lg:hidden",
          options: [
            { value: "light", label: "Light", icon: Sun, checked: theme === "light", onSelect: () => chooseTheme("light") },
            { value: "dark", label: "Dark", icon: Moon, checked: theme === "dark", onSelect: () => chooseTheme("dark") },
          ],
        },
        { kind: "separator", key: "end" },
        {
          kind: "item",
          key: "sign-out",
          label: signingOut ? "Signing out…" : "Sign out",
          icon: LogOut,
          busy: signingOut,
          keepOpen: true,
          onSelect: () => startSignOut(() => cmsSignOut()),
        },
      ]}
    />
  );
}
