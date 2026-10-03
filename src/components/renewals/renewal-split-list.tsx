"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/card";
import { SplitRow } from "@/components/ui/split-list";
import { SELECTED_PARAM } from "@/lib/view-mode";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { getRenewalStatus } from "@/lib/renewals";

type RenewalRow = {
  id: string;
  orderSeq: number;
  quantity: number;
  endDate: Date | string | null;
  company: { id: string; name: string };
  endCustomer: { id: string; name: string } | null;
  item: { id: string; name: string; unit: string | null };
};

/**
 * The narrow pane beside an open renewal. The expiry is the whole point of this list, so it sits on
 * the title's line where the amount goes elsewhere.
 */
export function RenewalSplitList({ renewals, selectedId }: { renewals: RenewalRow[]; selectedId: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function hrefFor(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(SELECTED_PARAM, id);
    return `${pathname}?${params.toString()}`;
  }

  return (
    <div className="divide-y divide-line">
      {renewals.map((renewal) => {
        const status = getRenewalStatus(renewal.endDate);
        return (
          <SplitRow
            key={renewal.id}
            href={hrefFor(renewal.id)}
            active={renewal.id === selectedId}
            title={renewal.company.name}
            trailing={formatCalendarDay(renewal.endDate)}
            subtitle={`${renewal.item.name} · ${renewal.quantity}${renewal.item.unit ? ` ${renewal.item.unit}` : ""}`}
            badges={
              <>
                <Badge tone={status.tone}>{status.label}</Badge>
                <span className="font-mono text-xs text-subtle">{formatOrderId(renewal.orderSeq)}</span>
                {renewal.endCustomer && <span className="text-xs text-subtle">for {renewal.endCustomer.name}</span>}
              </>
            }
          />
        );
      })}
      {renewals.length === 0 && <p className="px-4 py-8 text-center text-sm text-subtle">Nothing here yet.</p>}
    </div>
  );
}
