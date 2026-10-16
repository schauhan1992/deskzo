"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Search, X } from "lucide-react";
import { settingsForKeys } from "@/lib/settings/catalogue";
import { firstMatch, searchSettings } from "@/lib/settings/search";
import { Card } from "@/components/ui/card";

/**
 * All settings, as cards under their sections — with a search that narrows them as you type (owner,
 * 16 Oct 2026; src/lib/settings/search.ts). Enter opens the first match. Given the keys the viewer may
 * open; the entries themselves are rebuilt here, as an icon can't cross from a server component.
 */
export function SettingsDirectory({ visibleKeys }: { visibleKeys: string[] }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const sections = searchSettings(settingsForKeys(visibleKeys), term);

  return (
    <div className="space-y-8">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
        <input
          type="search"
          value={term}
          autoFocus
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setTerm("");
            if (e.key === "Enter") {
              const first = firstMatch(sections);
              if (first && term.trim()) router.push(first.href);
            }
          }}
          placeholder="Search settings — mail, GST, roles, branding…"
          aria-label="Search settings"
          className="h-10 w-full rounded-base border border-line bg-surface pl-9 pr-9 text-sm text-text placeholder:text-subtle focus:border-brand focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {term && (
          <button
            type="button"
            onClick={() => setTerm("")}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-subtle hover:text-text"
            aria-label="Clear the search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {sections.length === 0 && <p className="text-sm text-muted">No setting matches &ldquo;{term.trim()}&rdquo;.</p>}

      {sections.map((section) => (
        <section key={section.key}>
          <div className="mb-3">
            <h2 className="text-base font-semibold text-text">{section.label}</h2>
            <p className="mt-0.5 text-sm text-muted">{section.description}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {section.groups.map((group) => (
              <Card key={group.key} className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-subtle">{group.label}</p>
                <ul className="mt-3 space-y-3">
                  {group.items.map((item) => (
                    <li key={item.key}>
                      <Link href={item.href} className="group flex gap-2.5">
                        <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted transition-colors group-hover:text-brand" />
                        <span className="min-w-0">
                          <span className="flex items-center gap-1 text-sm font-medium text-text group-hover:text-brand">
                            {item.label}
                            {/* Says that following it leaves Settings, before you follow it. */}
                            {item.external && <ArrowUpRight className="h-3 w-3 text-subtle" />}
                          </span>
                          <span className="mt-0.5 block text-xs leading-relaxed text-muted">{item.description}</span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
