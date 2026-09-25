"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * The wins wall's sections. Routes rather than a `?tab=` — each is a page Settings and a notification
 * can link to directly.
 */
export function WinsTabs({ canManage }: { canManage: boolean }) {
  const pathname = usePathname();
  const tabs = [
    { href: "/wins", label: "Leaderboard" },
    { href: "/wins/most-active", label: "Most active" },
    { href: "/wins/hall-of-fame", label: "Hall of fame" },
    ...(canManage ? [{ href: "/wins/settings", label: "Prizes & settings" }] : []),
  ];
  return (
    <nav aria-label="Wins" className="mb-5 flex flex-wrap gap-x-1 border-b border-line">
      {tabs.map((t) => {
        const active = t.href === "/wins" ? pathname === "/wins" : pathname === t.href || !!pathname?.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
              active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
