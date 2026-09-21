"use client";

import { usePathname, useSearchParams } from "next/navigation";
import type { ResellerOnboardingStatus, ResellerTier } from "@prisma/client";
import { resellerStatusLabels, resellerTierLabels } from "@/lib/reseller-onboarding";
import { Badge } from "@/components/ui/card";
import { SplitRow } from "@/components/ui/split-list";
import { SELECTED_PARAM } from "@/lib/view-mode";

const STATUS_TONE: Record<ResellerOnboardingStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  SUSPENDED: "red",
  INACTIVE: "default",
};

type ResellerRow = {
  id: string;
  name: string;
  resellerProfile: { status: ResellerOnboardingStatus; tier: ResellerTier | null } | null;
  _count: { contacts: number; products: number; endCustomers: number };
  owner: { id: string; name: string } | null;
};

/**
 * The narrow pane beside an open reseller. A reseller is judged on where its onboarding got to and
 * how many end customers it brings, so those lead — not the pipeline stage a direct customer has.
 */
export function ResellerSplitList({
  resellers,
  selectedId,
}: {
  resellers: ResellerRow[];
  selectedId: string | null;
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
      {resellers.map((reseller) => {
        const status = reseller.resellerProfile?.status;
        return (
          <SplitRow
            key={reseller.id}
            href={hrefFor(reseller.id)}
            active={reseller.id === selectedId}
            title={reseller.name}
            subtitle={reseller.owner ? reseller.owner.name : "Unassigned"}
            badges={
              <>
                {status ? (
                  <Badge tone={STATUS_TONE[status]}>{resellerStatusLabels[status]}</Badge>
                ) : (
                  <Badge>No profile</Badge>
                )}
                {reseller.resellerProfile?.tier && (
                  <Badge tone="blue">{resellerTierLabels[reseller.resellerProfile.tier]}</Badge>
                )}
                <span className="text-xs text-subtle">
                  {reseller._count.endCustomers} end customer{reseller._count.endCustomers === 1 ? "" : "s"}
                </span>
              </>
            }
          />
        );
      })}
      {resellers.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}
