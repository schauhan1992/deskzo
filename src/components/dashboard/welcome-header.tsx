import Link from "next/link";
import type { ReactNode } from "react";
import { Mail, Phone } from "lucide-react";
import { IconPattern } from "@/components/layout/icon-pattern";
import { MomentChips } from "@/components/layout/celebration-splash";
import type { Moment } from "@/lib/hr/celebrations";
import type { HelpDeskView } from "@/actions/help";
import { cn } from "@/lib/utils";

export type DashboardTab = { key: string; label: string; badge?: number };

/**
 * The band across the top of the dashboard: who you are, which company this is, where to get help,
 * and the tabs — over a faint pattern of the things the business deals in.
 *
 * It runs edge to edge under the header rather than sitting in a card, by taking back the padding
 * the page gives everything else; the numbers below are the page's own padding, negated.
 */
export function WelcomeHeader({
  greeting,
  moments,
  companyName,
  logoDataUrl,
  helpDesk,
  tabs,
  activeTab,
  actions,
}: {
  greeting: string;
  moments: Moment[];
  companyName: string;
  logoDataUrl: string | null;
  helpDesk: HelpDeskView | null;
  tabs: DashboardTab[];
  activeTab: string;
  /** Beside the tabs, right-aligned — the Customize button on the Dashboard tab. */
  actions?: ReactNode;
}) {
  const initials = companyName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

  return (
    <section className="relative -mx-4 -mt-6 mb-6 overflow-hidden border-b border-line bg-surface md:-mx-6 md:-mt-8">
      {/* The pattern fades out towards the tabs, so they sit on a clean strip and read clearly. */}
      <IconPattern className="pointer-events-none absolute inset-0 h-full w-full text-brand opacity-[0.09] [mask-image:linear-gradient(to_bottom,black_40%,transparent)] dark:opacity-[0.14]" />

      <div className="relative flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-4 pt-5 md:px-6 md:pt-6">
        <div className="flex min-w-0 items-center gap-4">
          <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-line bg-surface shadow-sm">
            {logoDataUrl ? (
              // A data URL from Settings → Branding, so next/image has nothing to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoDataUrl} alt="" className="h-full w-full object-contain p-1.5" />
            ) : (
              <span className="text-lg font-semibold text-brand" aria-hidden="true">
                {initials || "·"}
              </span>
            )}
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-text">{greeting}</h1>
            <p className="truncate text-sm text-muted">{companyName}</p>
          </div>
        </div>

        {helpDesk && <HelplineCorner helpDesk={helpDesk} />}
      </div>

      {moments.some((m) => !m.splash) && (
        <div className="relative px-4 pt-3 md:px-6">
          <MomentChips moments={moments} />
        </div>
      )}

      <div className="relative mt-4 flex flex-wrap items-end justify-between gap-2 px-2 md:px-4">
        <nav aria-label="Dashboard" className="-mb-px flex gap-0.5 overflow-x-auto [scrollbar-width:none] sm:gap-1 [&::-webkit-scrollbar]:hidden">
          {tabs.map((t) => {
            const active = t.key === activeTab;
            return (
              <Link
                key={t.key}
                href={t.key === tabs[0]?.key ? "/dashboard" : `/dashboard?tab=${t.key}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2 pb-2.5 pt-1 text-[13px] font-medium transition-colors sm:px-3 sm:text-sm",
                  active ? "border-brand text-text" : "border-transparent text-muted hover:text-text",
                )}
              >
                {t.label}
                {!!t.badge && (
                  <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold leading-4 text-brand-contrast">
                    {t.badge > 9 ? "9+" : t.badge}
                    <span className="sr-only"> new</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {actions && <div className="pb-2">{actions}</div>}
      </div>
    </section>
  );
}

/** The support corner: label and number, then hours and languages, small and to the right. */
function HelplineCorner({ helpDesk }: { helpDesk: HelpDeskView }) {
  return (
    <div className="min-w-0 text-left text-xs text-muted sm:text-right">
      {helpDesk.phone && (
        <p className="text-sm text-text">
          {helpDesk.label ? `${helpDesk.label}: ` : "Helpline: "}
          <a href={`tel:${helpDesk.phone.replace(/[^\d+]/g, "")}`} className="font-semibold hover:underline">
            <Phone className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-brand" aria-hidden="true" />
            {helpDesk.phone}
          </a>
        </p>
      )}
      {helpDesk.hours && <p className="mt-0.5">{helpDesk.hours}</p>}
      {helpDesk.languages && <p className="mt-0.5">{helpDesk.languages}</p>}
      {helpDesk.email && (
        <p className="mt-0.5">
          <a href={`mailto:${helpDesk.email}`} className="hover:text-text hover:underline">
            <Mail className="mr-1 inline h-3 w-3 align-[-1px]" aria-hidden="true" />
            {helpDesk.email}
          </a>
        </p>
      )}
    </div>
  );
}
