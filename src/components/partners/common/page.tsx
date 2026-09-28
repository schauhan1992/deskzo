import type { ReactNode } from "react";
import { PageHeader, type Crumb } from "@/components/console/kit/page-header";

/**
 * The top of every partner portal page and the column its sections stack in: the console kit's
 * `PageHeader` (title, chips, one factual subtitle line, the page's actions, and the one outcome
 * region every change reports to), then the page's sections, `space-y-6` apart.
 *
 * `crumbs` is the way back from a detail page — `[{ label: "Customers", href: PARTNER_ROUTES.customers }]`
 * on /customers/acme — and the current page's title is added at its end. A list page passes none: the
 * sidebar already says where it is. `asOf` is the loader's clock ("Updated 10:02 IST"), never the
 * reader's.
 *
 * Server-safe: no hooks, no directive.
 */
export function PortalPage({
  title,
  subtitle,
  actions,
  chips,
  crumbs,
  asOf,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  chips?: ReactNode;
  crumbs?: Crumb[];
  asOf?: Date | null;
  children: ReactNode;
}) {
  const trail = crumbs && crumbs.length > 0 ? [...crumbs, { label: title }] : undefined;
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} chips={chips} crumbs={trail} asOf={asOf} />
      <div className="space-y-6">{children}</div>
    </>
  );
}
