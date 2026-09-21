import type { Metadata } from "next";
import {
  openPortal,
  portalInvoices,
  portalSubscriptions,
  portalTickets,
} from "@/actions/portal-public";
import { REFUSAL_MESSAGE } from "@/lib/portal/access";
import { Card } from "@/components/ui/card";
import { PortalHome } from "@/components/portal/portal-home";

/**
 * `referrer: no-referrer` because the token is in the URL, and `noindex` because a portal link that
 * turns up in a search result is one anybody can use. Same reasoning as the feedback form and the
 * preference centre — see src/app/(public)/review/[token]/page.tsx.
 */
export const metadata: Metadata = {
  title: "Your account",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

// Never cached. An expiry that has passed or a link just revoked must take effect on the next load,
// not whenever a cache decides.
export const dynamic = "force-dynamic";

export default async function PortalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const view = await openPortal(token);
  if (!view) {
    return (
      <Card className="mx-auto max-w-lg px-6 py-12 text-center">
        <h1 className="text-lg font-semibold text-text">{REFUSAL_MESSAGE}</h1>
        <p className="mt-2 text-sm text-muted">
          Reply to any email you&apos;ve had from us and we&apos;ll send you a new one.
        </p>
      </Card>
    );
  }

  /**
   * Each section fetched only when it exists for this viewer.
   *
   * The action refuses a hidden section on its own — it does not trust this page — but not asking
   * is the belt to that braces, and it keeps a switched-off section from costing a query.
   */
  const [subscriptions, invoices, tickets] = await Promise.all([
    view.sections.includes("subscriptions") ? portalSubscriptions(token) : Promise.resolve([]),
    view.sections.includes("invoices") ? portalInvoices(token) : Promise.resolve([]),
    view.sections.includes("tickets") ? portalTickets(token) : Promise.resolve([]),
  ]);

  return (
    <PortalHome token={token} view={view} subscriptions={subscriptions} invoices={invoices} tickets={tickets} />
  );
}
