import Link from "next/link";
import { Card } from "@/components/ui/card";
import { formatRupees } from "@/lib/accounts/money";
import { cn } from "@/lib/utils";
import type { GlanceCard } from "@/actions/accounts-reports";

/**
 * "Accounts at a glance" (owner, 22 Oct 2026): what needs looking at across the books and the stock, each figure
 * a link to the page that deals with it. Only the cards this person may follow are here (`accountsGlance`).
 */
export function GlanceStrip({ cards }: { cards: GlanceCard[] }) {
  if (cards.length === 0) return null;
  return (
    <section aria-labelledby="accounts-glance" className="mt-4">
      <h2 id="accounts-glance" className="text-sm font-medium text-text">
        Accounts at a glance
      </h2>
      <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        {cards.map((c) => (
          <Link key={c.key} href={c.href} className="block">
            <Card className="h-full px-4 py-3 transition-colors hover:bg-surface-sunken">
              <div className="text-xs uppercase tracking-wide text-subtle">{c.label}</div>
              <div
                className={cn(
                  "mt-1 text-lg font-semibold tabular-nums",
                  c.tone === "danger" && c.value !== 0 ? "text-danger" : c.tone === "warning" && c.value !== 0 ? "text-warning" : "text-text",
                )}
              >
                {c.kind === "money" ? formatRupees(c.value) : c.value.toLocaleString("en-IN")}
              </div>
              {c.hint && <div className="mt-0.5 text-xs text-muted">{c.hint}</div>}
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}
