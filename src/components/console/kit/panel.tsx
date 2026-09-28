import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The console's card (replaces the legacy `Section`): a header with a title, a one-line description
 * and actions, a body, and an optional footer. `padded={false}` lets a table bleed to the edges.
 * No hover shadow — a card that lifts under the pointer promises a click it does not have.
 */
export function Panel({
  title,
  description,
  actions,
  footer,
  children,
  tone = "default",
  padded = true,
  id,
  className,
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  tone?: "default" | "danger";
  padded?: boolean;
  id?: string;
  className?: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const danger = tone === "danger";
  return (
    // scroll-mt clears the sticky top bar when a link lands on the panel's id (/provisioning#warm-pool).
    <section id={id} className={cn("min-w-0 scroll-mt-20 rounded-xl border bg-surface shadow-sm", danger ? "border-danger/40" : "border-line", className)}>
      {(title || description || actions) && (
        <div className={cn("flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3", danger ? "border-danger/40" : "border-line")}>
          <div className="min-w-0">
            {title && <Heading className={cn("text-sm font-semibold", danger ? "text-danger" : "text-text")}>{title}</Heading>}
            {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={padded ? "px-5 py-4" : "min-w-0"}>{children}</div>
      {footer && <div className="border-t border-line px-5 py-2.5 text-xs text-muted">{footer}</div>}
    </section>
  );
}

const COLUMNS: Record<1 | 2 | 3, string> = {
  1: "",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
};

/** Term/value pairs; `wide` items take a whole row (an address, a reason). */
export function DefinitionList({ items, columns = 2 }: { items: { term: string; value: ReactNode; wide?: boolean }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", COLUMNS[columns])}>
      {items.map((item, i) => (
        <div key={`${i}-${item.term}`} className={cn("min-w-0", item.wide && "sm:col-span-full")}>
          <dt className="text-xs text-muted">{item.term}</dt>
          <dd className="mt-0.5 text-sm break-words text-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SubHeading({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[13px] font-medium text-text">{children}</h3>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A block set into a panel — a grant's details, a one-time secret, a preview. */
export function InsetBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-lg border border-line bg-surface-sunken px-4 py-3", className)}>{children}</div>;
}
