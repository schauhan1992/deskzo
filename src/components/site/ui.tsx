import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { isInternal, safeHref } from "@/components/site/links";
import { cn } from "@/lib/utils";

/**
 * The public site's building blocks: the page width, a section's rhythm, its heading, and links that
 * look like buttons. Colours are the app's tokens only (src/app/globals.css), so the site follows the
 * light and dark themes and the brand colour like everything else.
 */

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  // 1440px wide on a large screen, as modern sites are; text inside keeps its own reading width (max-w-2xl/3xl).
  return <div className={cn("mx-auto w-full max-w-[90rem] px-4 sm:px-6 lg:px-10", className)}>{children}</div>;
}

export function Section({ id, className, children, tone = "plain" }: { id?: string; className?: string; children: ReactNode; tone?: "plain" | "sunken" }) {
  return (
    <section id={id || undefined} className={cn("scroll-mt-20 py-16 sm:py-24", tone === "sunken" && "border-y border-line bg-surface-sunken", className)}>
      <Container>{children}</Container>
    </section>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-sm font-semibold tracking-wide text-brand", className)}>{children}</p>;
}

/** A section's eyebrow, h2 and introduction. */
export function SectionHeading({ eyebrow, heading, intro, align = "left", className }: { eyebrow?: string; heading: string; intro?: string; align?: "left" | "center"; className?: string }) {
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center", className)}>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2 className={cn("text-3xl font-semibold tracking-tight text-text text-balance sm:text-4xl", eyebrow && "mt-2")}>{heading}</h2>
      {intro && <p className="mt-4 text-base leading-7 text-muted text-pretty sm:text-lg">{intro}</p>}
    </div>
  );
}

/**
 * A link from content: next/link on this site, a plain anchor elsewhere (opening in the same tab —
 * nothing on this site is worth keeping a tab for), and plain text when the address fails the check.
 */
export function SiteAnchor({ href, className, children, ...rest }: { href: string; className?: string; children: ReactNode; "aria-current"?: "page" }) {
  const safe = safeHref(href);
  if (!safe) return <span className={className}>{children}</span>;
  if (isInternal(safe)) {
    return (
      <Link href={safe} className={className} {...rest}>
        {children}
      </Link>
    );
  }
  return (
    <a href={safe} className={className} rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  );
}

const BUTTON = {
  primary: "bg-brand text-brand-contrast shadow-sm hover:brightness-110 active:brightness-95",
  secondary: "border border-line-strong bg-surface text-text shadow-sm hover:bg-surface-sunken",
  ghost: "text-muted hover:bg-surface-sunken hover:text-text",
  inverse: "bg-brand-contrast text-brand shadow-sm hover:opacity-90",
  outlineInverse: "border border-brand-contrast/40 text-brand-contrast hover:bg-brand-contrast/10",
} as const;
const SIZE = { md: "h-9 px-3.5 text-sm", lg: "h-11 px-5 text-[15px]" } as const;

export type ButtonTone = keyof typeof BUTTON;

export function buttonClasses(tone: ButtonTone = "primary", size: keyof typeof SIZE = "md") {
  return cn(
    "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-base font-medium",
    "transition-[background-color,color,box-shadow,filter,opacity,transform] duration-150 active:scale-[0.98]",
    BUTTON[tone],
    SIZE[size],
  );
}

/** A link that looks like a button. */
export function ButtonLink({ href, label, tone = "primary", size = "md", arrow = false, className }: { href: string; label: string; tone?: ButtonTone; size?: keyof typeof SIZE; arrow?: boolean; className?: string }) {
  return (
    <SiteAnchor href={href} className={cn(buttonClasses(tone, size), "group", className)}>
      {label}
      {arrow && <ArrowRight aria-hidden="true" className="h-4 w-4 transition-transform duration-150 group-hover:translate-x-0.5" />}
    </SiteAnchor>
  );
}

/** Where a page sits on the site — "Home › Product › CRM": the pages above it as links, then this one. */
export function Breadcrumbs({ trail, current, className }: { trail: { name: string; href: string }[]; current: string; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        {trail.map((crumb, i) => (
          <li key={i} className="flex min-w-0 max-w-full items-center gap-1.5">
            <SiteAnchor href={crumb.href} className="truncate font-medium text-muted transition-colors hover:text-text">
              {crumb.name}
            </SiteAnchor>
            <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
          </li>
        ))}
        <li className="min-w-0 max-w-full">
          <span aria-current="page" className="block truncate text-subtle">
            {current}
          </span>
        </li>
      </ol>
    </nav>
  );
}

/** "Sample data" — on every product preview, so a screenshot of one is never taken for a customer's. */
export function SampleBadge({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-subtle", className)}>
      Sample data
    </span>
  );
}
