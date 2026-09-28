import type { ReactNode } from "react";
import { Building2, HandCoins, Handshake, Ticket } from "lucide-react";
import { EnvBadge } from "@/components/console/kit/env-badge";
import type { PlatformEnv } from "@/lib/console-shared/types";

/**
 * The frame around the partner portal's doors — /login, /enrol, /setup — outside the portal shell,
 * because nobody on them has a session that is through two-factor yet. The same shape as the CMS's
 * and the console's doors (src/components/cms/shell/auth-frame.tsx), so the apps feel like one
 * family: from `lg`, what the portal is for and which installation it is on the left, the one card on
 * the right; below that one column, the left pane reduced to a strip so the form is never pushed
 * under the fold on a phone.
 *
 * The product's name is not written here — "Partner portal" says what this is without it.
 */
export function PartnerAuthFrame({
  env,
  title,
  subtitle,
  children,
  footer,
}: {
  env: PlatformEnv;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-sunken lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 lg:flex-col lg:items-stretch lg:border-r lg:border-b-0 lg:bg-[radial-gradient(120%_70%_at_0%_0%,color-mix(in_srgb,var(--brand)_9%,transparent),transparent_70%)] lg:px-10 lg:py-10 xl:px-14">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-brand-contrast">
            <Handshake className="h-4 w-4" />
          </span>
          <p className="truncate text-sm font-semibold text-text">Partner portal</p>
        </div>

        <div className="hidden max-w-sm lg:block">
          <p className="text-2xl font-semibold tracking-tight text-text">Your customers, your pipeline, your commission.</p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            For the companies that sell and support the product — and the people who work for them. Partner portal accounts are separate from every workspace and
            from the platform&apos;s own staff.
          </p>
          <ul className="mt-6 space-y-2.5 text-sm text-muted">
            <li className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-lg bg-surface text-brand shadow-sm">
                <Building2 className="h-3.5 w-3.5" />
              </span>
              Every customer credited to you, with plans and renewals
            </li>
            <li className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-lg bg-surface text-brand shadow-sm">
                <Ticket className="h-3.5 w-3.5" />
              </span>
              Invitation codes, referral links and deal registrations
            </li>
            <li className="flex items-center gap-2.5">
              <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-lg bg-surface text-brand shadow-sm">
                <HandCoins className="h-3.5 w-3.5" />
              </span>
              Commission on every paid invoice, and monthly statements
            </li>
          </ul>
        </div>

        <div className="flex shrink-0 items-center gap-3 lg:flex-col lg:items-start">
          <EnvBadge env={env} size="md" />
          <p className="hidden text-[11px] text-subtle lg:block">Every sign-in is recorded in your partner account&apos;s activity log.</p>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 py-10 md:py-16">
        <div className="w-full max-w-sm animate-fade-rise">
          <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
            <h1 className="text-lg font-semibold tracking-tight text-text">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
            <div className="mt-5">{children}</div>
          </div>
          {footer && <div className="mt-4 text-center text-xs text-muted">{footer}</div>}
        </div>
      </main>
    </div>
  );
}
