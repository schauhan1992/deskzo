"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/workspaces", label: "Workspaces" },
  { href: "/provisioning", label: "Provisioning" },
  { href: "/migrations", label: "Migrations" },
  { href: "/invites", label: "Invitations" },
  { href: "/devices", label: "Terminals" },
  { href: "/reference", label: "Reference data" },
  { href: "/staff", label: "Staff" },
  { href: "/audit", label: "Audit log" },
] as const;

/** The console's sections. The browser's address is the console's own (`/workspaces`), not the folder's. */
export function ConsoleNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Console" className="flex flex-wrap gap-1">
      {LINKS.map((link) => {
        const active = link.href === "/" ? pathname === "/" : pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn("rounded-base px-2.5 py-1.5 text-sm", active ? "bg-brand-subtle font-medium text-brand" : "text-muted hover:bg-surface-sunken hover:text-text")}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
