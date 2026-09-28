import type { ReactNode } from "react";
import type { PlatformEnv } from "@/lib/console-shared/types";
import { EnvBadge } from "@/components/console/kit/env-badge";

/**
 * The frame around the console's doors — /login, /enrol, /setup. They sit outside the console shell,
 * because nobody on them has a session that passed two-factor yet: no sidebar, no search, nothing to
 * navigate to. From `lg` it is two panes — who the console is for and which installation it is on the
 * left, the one card on the right; below that one column, the brand pane reduced to a strip so the
 * form is never pushed under the fold on a phone.
 *
 * The environment badge is here on purpose. A password typed into staging by mistake costs nothing;
 * one typed into production by somebody who believed it was staging is how a test click reaches a
 * paying customer.
 */
export function AuthFrame({
  env,
  title,
  subtitle,
  children,
  footer,
}: {
  env: PlatformEnv;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-sunken lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <header className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-3 lg:flex-col lg:items-stretch lg:border-r lg:border-b-0 lg:bg-[radial-gradient(120%_70%_at_0%_0%,color-mix(in_srgb,var(--brand)_9%,transparent),transparent_70%)] lg:px-10 lg:py-10 xl:px-14">
        <div className="flex min-w-0 items-center gap-2.5">
          <span aria-hidden="true" className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand text-[11px] font-bold text-brand-contrast">
            W
          </span>
          <p className="truncate text-sm font-semibold text-text">Wroffy console — staff only</p>
        </div>

        <div className="hidden max-w-sm lg:block">
          <p className="text-2xl font-semibold tracking-tight text-text">For Wroffy staff.</p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Workspace accounts don&apos;t sign in here — each customer signs in at their own workspace&apos;s address.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-3 lg:flex-col lg:items-start">
          <EnvBadge env={env} size="md" />
          <p className="hidden text-[11px] text-subtle lg:block">Every sign-in is recorded in the console&apos;s audit log.</p>
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
