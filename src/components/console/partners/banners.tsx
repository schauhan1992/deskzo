import type { ReactNode } from "react";
import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { dayMonthYear, plural } from "@/lib/console-shared/format";
import type { Caps } from "@/lib/console-shared/roles";
import type { PartnerHeader } from "@/lib/partners/console-data";
import { REQUESTS_PATH, partnerPath } from "./format";
import { PartnerTabLink } from "./tab-link";

/**
 * What to read about a partner before anything else on its page (spec §9.2) — only what is true now,
 * most serious first: terminated with customers still attributed, suspended, no terms in force, no
 * active admin, a payout change waiting, still onboarding. Each says what it means and, where there
 * is one, offers the next step to the roles that can take it. Server-safe.
 *
 * `statusReason` is staff's own words for the last status change: staff read it here; the partner
 * never does.
 */

const LINK_BUTTON =
  "inline-flex h-8 shrink-0 items-center rounded-base border border-line-strong bg-surface px-3 text-[13px] font-medium whitespace-nowrap text-text shadow-sm hover:bg-surface-sunken";

export function PartnerBanners({ header, caps }: { header: PartnerHeader; caps: Caps }) {
  const base = partnerPath(header.slug);
  const toTab = (tab: string, label: string) => (
    <PartnerTabLink tab={tab} href={`${base}?tab=${tab}`} className={LINK_BUTTON}>
      {label}
    </PartnerTabLink>
  );
  const banners: { key: string; node: ReactNode }[] = [];
  const add = (key: string, node: ReactNode) => banners.push({ key, node });
  const reason = header.statusReason ? `“${header.statusReason}”` : null;

  if (header.status === "TERMINATED") {
    const n = header.customersStillAttributed;
    add(
      "terminated",
      <Banner
        tone={n > 0 ? "warning" : "neutral"}
        title={n > 0 ? `Terminated — ${plural(n, "customer")} still attributed` : `Terminated${header.terminatedAt ? ` on ${dayMonthYear(header.terminatedAt)}` : ""}`}
        action={n > 0 ? toTab("customers", "See the customers") : undefined}
      >
        {n > 0
          ? "No commission accrues on their invoices from the termination on. Reassign each one from its workspace page, with a reason."
          : "Signing in is refused. What it was owed is still paid on its statements."}
        {reason && <span className="mt-1 block">{`Reason: ${reason}`}</span>}
      </Banner>,
    );
  }

  if (header.status === "SUSPENDED") {
    add(
      "suspended",
      <Banner tone="warning" title={`Suspended${header.suspendedAt ? ` since ${dayMonthYear(header.suspendedAt)}` : ""}`}>
        It can sign in and keeps earning on its customers, but it can&apos;t sell: no new codes, links or deal registrations, and its codes stop attributing.
        {reason && <span className="mt-1 block">{`Reason: ${reason}`}</span>}
      </Banner>,
    );
  }

  if (!header.termsInForce && header.status !== "TERMINATED") {
    add(
      "no-terms",
      <Banner tone="warning" title="No terms in force" action={caps.partnerMoney ? toTab("terms", "Open Terms") : undefined}>
        It earns nothing on its customers&apos; invoices until commission terms are in force{header.status === "ONBOARDING" ? ", and it can't be activated before that" : ""}.
      </Banner>,
    );
  }

  if (header.activeAdmins === 0 && header.status !== "TERMINATED") {
    add(
      "no-admin",
      <Banner tone="warning" title="No active admin" action={toTab("users", "Open Users")}>
        Nobody can run its team or its requests in the partner portal{caps.managePartners ? " — invite its first admin from the top of this page" : ""}.
      </Banner>,
    );
  }

  if (header.payoutRequestPending) {
    add(
      "payout-request",
      <Banner
        tone="info"
        title="A payout details change is waiting"
        action={
          caps.partnerMoney ? (
            <Link href={`${REQUESTS_PATH}?tab=changes`} className={LINK_BUTTON}>
              Open the request
            </Link>
          ) : undefined
        }
      >
        The partner asked to change its bank details. Owners and billing staff approve or reject it.
      </Banner>,
    );
  }

  if (header.status === "ONBOARDING") {
    add(
      "onboarding",
      <Banner tone="info" title="Onboarding">
        It can sign in and set up, but sells nothing until it is activated — which needs terms in force and an active admin.
      </Banner>,
    );
  }

  if (banners.length === 0) return null;
  return (
    <div className="space-y-3">
      {banners.map((b) => (
        <div key={b.key}>{b.node}</div>
      ))}
    </div>
  );
}
