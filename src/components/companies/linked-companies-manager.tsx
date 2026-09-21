"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { linkCommissionPartyToCompany, unlinkCommissionPartyFromCompany } from "@/actions/commission-party";
import { Button } from "@/components/ui/button";
import { CompanyCombobox } from "@/components/ui/company-combobox";

export type LinkedCompany = { linkId: string; id: string; name: string };

/**
 * A `CommissionPartyLink` read from whichever end you're standing on. On a commission party's page
 * the party is fixed and you pick the customer; on a customer's page the customer is fixed and you
 * pick the party. Same row, same actions — only which side is fixed changes, so `side` says which
 * one `ownerId` is rather than duplicating the component.
 */
export function LinkedCompaniesManager({
  ownerId,
  side,
  links,
  companyOptions,
  emptyText,
  searchPlaceholder,
}: {
  ownerId: string;
  side: "commissionParty" | "company";
  links: LinkedCompany[];
  companyOptions: { id: string; name: string }[];
  emptyText?: string;
  searchPlaceholder?: string;
}) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState("");
  const [isLinking, setIsLinking] = useState(false);
  const [pendingLinkId, setPendingLinkId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linkedIds = new Set(links.map((l) => l.id));
  const availableOptions = companyOptions.filter((c) => !linkedIds.has(c.id));

  function handleLink() {
    if (!selectedId) return;
    setError(null);
    setIsLinking(true);
    const [partyId, companyId] =
      side === "commissionParty" ? [ownerId, selectedId] : [selectedId, ownerId];
    linkCommissionPartyToCompany(partyId, companyId).then((result) => {
      setIsLinking(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSelectedId("");
      router.refresh();
    });
  }

  function handleUnlink(linkId: string) {
    setError(null);
    setPendingLinkId(linkId);
    unlinkCommissionPartyFromCompany(linkId).then((result) => {
      setPendingLinkId(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {links.length === 0 && (
        <p className="text-sm text-subtle">
          {emptyText ?? "Not linked to any customer yet — link the company this party refers business from."}
        </p>
      )}
      {links.map((l) => (
        <div key={l.linkId} className="flex items-center justify-between text-sm">
          <Link href={`/companies/${l.id}`} className="font-medium text-text hover:underline">
            {l.name}
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-danger hover:bg-danger-bg hover:text-danger"
            disabled={pendingLinkId === l.linkId}
            onClick={() => handleUnlink(l.linkId)}
          >
            {pendingLinkId === l.linkId ? "Unlinking…" : "Unlink"}
          </Button>
        </div>
      ))}

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <CompanyCombobox
            companies={availableOptions}
            value={selectedId}
            onSelect={(company) => setSelectedId(company?.id ?? "")}
            placeholder={searchPlaceholder ?? "Type to search customer companies…"}
          />
        </div>
        <Button type="button" size="sm" disabled={!selectedId || isLinking} onClick={handleLink}>
          {isLinking ? "Linking…" : "Link"}
        </Button>
      </div>
    </div>
  );
}
