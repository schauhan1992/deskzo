"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { CompanyStage, CompanyRelationshipType, VendorStatus } from "@prisma/client";
import { Badge } from "@/components/ui/card";
import { SplitRow } from "@/components/ui/split-list";
import { SELECTED_PARAM } from "@/lib/view-mode";
import { vendorStatusLabels } from "@/lib/validation/company";
import { CategoryIcon } from "@/components/customers/category-chip";
import type { CategoryWithParent } from "@/lib/customers/categories";

const STAGE_TONE: Record<CompanyStage, "default" | "green" | "blue" | "red" | "amber"> = {
  PROSPECT: "default",
  LEAD: "blue",
  CUSTOMER: "green",
  DISQUALIFIED: "red",
};

const VENDOR_STATUS_TONE: Record<VendorStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  INACTIVE: "default",
};

type CompanyRow = {
  id: string;
  name: string;
  stage: CompanyStage;
  relationshipType: CompanyRelationshipType;
  vendorStatus?: VendorStatus | null;
  _count: { contacts: number; leads: number; products?: number };
  owner: { id: string; name: string } | null;
  customerCategory?: CategoryWithParent | null;
};

/**
 * The narrow pane beside an open company. Shared by every list that is really a list of companies —
 * Companies, Customers, Vendors, Resellers and Commission parties — with `isVendor` deciding
 * whether a row leads with its pipeline stage or its vendor status, since those are the two
 * different questions people scan these lists for.
 */
export function CompanySplitList({
  companies,
  selectedId,
  isVendor = false,
}: {
  companies: CompanyRow[];
  selectedId: string | null;
  isVendor?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {companies.map((company) => {
        // A won deal only counts as a Customer once an order exists — otherwise it's a closed deal
        // still waiting for its first order, which is a different thing to chase.
        const awaitingOrder = company.stage === "CUSTOMER" && (company._count.products ?? 0) === 0;
        return (
          <SplitRow
            key={company.id}
            href={hrefFor(company.id)}
            active={company.id === selectedId}
            title={company.name}
            subtitle={company.owner ? company.owner.name : "Unassigned"}
            badges={
              <>
                <CategoryIcon category={company.customerCategory} />
                {isVendor && company.vendorStatus ? (
                  <Badge tone={VENDOR_STATUS_TONE[company.vendorStatus]}>
                    {vendorStatusLabels[company.vendorStatus]}
                  </Badge>
                ) : (
                  <Badge tone={awaitingOrder ? "amber" : STAGE_TONE[company.stage]}>
                    {awaitingOrder ? "Awaiting Order" : company.stage}
                  </Badge>
                )}
                {company.relationshipType === "RESELLER" && <Badge tone="blue">Reseller</Badge>}
                <span className="text-xs text-subtle">
                  {company._count.contacts} contact{company._count.contacts === 1 ? "" : "s"}
                </span>
              </>
            }
          />
        );
      })}
      {companies.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}
