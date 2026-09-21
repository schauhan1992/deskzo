"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, ChevronLeft } from "lucide-react";
import { activeSettingsKey, settingsForKeys } from "@/lib/settings/catalogue";
import { cn } from "@/lib/utils";

/**
 * The settings sidebar.
 *
 * Replaces a horizontal strip of eight tabs that scrolled sideways on a laptop and showed every tab
 * to everybody. A vertical list has room for the labels, room for the groups, and room to grow —
 * which matters, because the last four features each added a settings screen and the strip was
 * already full at six.
 *
 * Hidden on the index itself: that page is the map, and a map does not need a legend beside it.
 */
export function SettingsNav({ visibleKeys }: { visibleKeys: string[] }) {
  const pathname = usePathname();
  if (pathname === "/settings") return null;

  // Rebuilt here rather than handed over ready-made: each entry holds an icon component, and a
  // function cannot be serialised from a server component to a client one. Keys can.
  const sections = settingsForKeys(visibleKeys);
  const active = activeSettingsKey(pathname);

  return (
    <nav className="shrink-0 md:w-56">
      <Link
        href="/settings"
        className="mb-3 inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-text"
      >
        <ChevronLeft className="h-4 w-4" />
        All settings
      </Link>

      {/* Scrolls with the page on a phone, sticks beside it from md up. */}
      <div className="space-y-5 md:sticky md:top-20">
        {sections.map((section) => (
          <div key={section.key}>
            <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{section.label}</p>
            <div className="mt-1.5 space-y-3">
              {section.groups.map((group) => (
                <div key={group.key}>
                  <p className="px-2 text-xs text-subtle">{group.label}</p>
                  <ul className="mt-0.5">
                    {group.items.map((item) => (
                      <li key={item.key}>
                        <Link
                          href={item.href}
                          className={cn(
                            "flex items-center gap-2 rounded-base px-2 py-1.5 text-sm transition-colors",
                            active === item.key
                              ? "bg-brand-subtle font-medium text-brand"
                              : "text-muted hover:bg-surface-sunken hover:text-text",
                          )}
                        >
                          <item.icon className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">{item.label}</span>
                          {/*
                            Marked, because clicking it leaves Settings. Following a link into
                            /accounting and finding the settings sidebar gone reads as a bug unless
                            you were told it would happen.
                          */}
                          {item.external && <ArrowUpRight className="ml-auto h-3 w-3 shrink-0 text-subtle" />}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </nav>
  );
}
