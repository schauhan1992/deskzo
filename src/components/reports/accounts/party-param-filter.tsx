"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { searchRegisterParties } from "@/actions/accounts-reports";

/**
 * The sales or purchase register narrowed to one customer or vendor, kept in the URL (`party`) like the other
 * filters, and back to the first page on every change. Searches the server as you type, since a company list
 * runs to thousands; offers only parties with a document of the register's direction.
 */
export function PartyParamFilter({ direction, selected }: { direction: "SALES" | "PURCHASE"; selected: CompanyComboOption | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const inputId = useId();

  function choose(company: CompanyComboOption | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (company) params.set("party", company.id);
    else params.delete("party");
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={inputId} className="text-muted">
        {direction === "SALES" ? "Customer" : "Vendor"}
      </label>
      <div className="w-64">
        <CompanyCombobox
          id={inputId}
          companies={selected ? [selected] : []}
          value={selected?.id ?? ""}
          onSelect={choose}
          search={(q) => searchRegisterParties(q, direction)}
          placeholder={`All — type a ${direction === "SALES" ? "customer" : "vendor"}…`}
        />
      </div>
    </div>
  );
}
