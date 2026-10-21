"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { navHeadingOf, type VisibleNavItem, type VisibleNavSection } from "@/lib/navigation";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

/**
 * Where a page sits in a split group — Finance › Accounts › Inventory › Stock vouchers (owner, 22 Oct 2026).
 *
 * Built from the same menu the sidebar draws (`buildNavigation`), so it never names a page the person can't
 * open. Only for the groups drawn in parts: elsewhere the sidebar's one level already says where you are.
 */
export function NavBreadcrumb({ navigation }: { navigation: VisibleNavSection[] }) {
  const pathname = usePathname() ?? "";
  const wording = useWording();

  // The most specific link the page is at or under.
  let best: { section: VisibleNavSection; item: VisibleNavItem } | null = null;
  for (const section of navigation) {
    for (const item of section.items) {
      const hit = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (hit && (!best || item.href.length > best.item.href.length)) best = { section, item };
    }
  }
  if (!best?.item.section) return null;

  const { section, item } = best;
  const label = (i: VisibleNavItem) => (i.term ? slot(wording, i.label, i.term.key, i.term.template) : i.label);
  const firstOfPart = section.items.find((i) => i.section === item.section) ?? item;
  const heading = navHeadingOf(section.group);
  const atLink = pathname === item.href;

  const crumbs: { label: string; href?: string; current?: boolean }[] = [
    ...(heading ? [{ label: heading }] : []),
    { label: section.group, href: section.items[0]?.href },
    ...(item.section !== label(item) ? [{ label: item.section!, href: firstOfPart.href }] : []),
    { label: label(item), href: atLink ? undefined : item.href, current: atLink },
  ];

  return (
    <nav aria-label="Breadcrumb" className="mb-3 text-xs text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        {crumbs.map((crumb, i) => (
          <li key={`${crumb.label}-${i}`} className="flex items-center gap-1">
            {i > 0 && <ChevronRight aria-hidden="true" className="h-3 w-3 text-subtle" />}
            {crumb.href ? (
              <Link href={crumb.href} className="hover:text-text hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span aria-current={crumb.current ? "page" : undefined} className={crumb.current ? "font-medium text-text" : undefined}>
                {crumb.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
