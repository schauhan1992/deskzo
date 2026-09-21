"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { bulkCreateRenewalTasks } from "@/actions/renewal";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatDate } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";
import { getRenewalStatus } from "@/lib/renewals";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { CallButton } from "@/components/calls/call-button";
import { useColumns } from "@/components/ui/table-columns";

type RenewalRow = {
  id: string;
  orderSeq: number;
  quantity: number;
  poNumber: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  company: {
    id: string;
    name: string;
    owner?: { id: string; name: string } | null;
    /** The person to ring, so the call button opens on them rather than a picker. */
    contacts?: { id: string; name: string; phone: string | null }[];
  };
  endCustomer: { id: string; name: string } | null;
  item: { id: string; name: string; unit: string | null };
  /**
   * The parent and everything co-terminating with it, because "15 seats expiring on the 9th" is the
   * renewal conversation — not "10 seats, and separately 5 seats".
   */
  group?: { totalQuantity: number; addonCount: number; renewalValue: number; incomplete: boolean; note: string };
  /** Present once a renewal has been punched — the row then says so instead of asking again. */
  renewedBy?: { id: string; orderSeq: number; orderStatus: string } | null;
};

export function RenewalsTable({
  renewals,
  users,
}: {
  renewals: RenewalRow[];
  users: { id: string; name: string }[];
}) {
  const cols = useColumns("renewals");
  const router = useRouter();
  const selection = useRowSelection(renewals);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [assignedToUserId, setAssignedToUserId] = useState("");
  const [dueDate, setDueDate] = useState("");

  function createTasks() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkCreateRenewalTasks({ orderIds: selection.ids, assignedToUserId, dueDate });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, skipped } = result.data;
      setNotice(`Created ${count} renewal task(s).` + (skipped > 0 ? ` ${skipped} already had an open task.` : ""));
      setAssignedToUserId("");
      setDueDate("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        <Select
          value={assignedToUserId}
          onChange={(e) => setAssignedToUserId(e.target.value)}
          className="h-9 w-52"
          aria-label="Assign to"
        >
          <option value="">Assign to — nobody</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Input
          type="date"
          value={dueDate}
          onChange={(e) => setDueDate(e.target.value)}
          className="h-9 w-44"
          aria-label="Task due date"
          title="Leave blank to use each subscription's own expiry date"
        />
        <Button size="sm" disabled={isPending} onClick={createTasks}>
          {isPending ? "Creating…" : "Create renewal tasks"}
        </Button>
      </BulkBar>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {cols.show("select") && (
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox
                      checked={selection.allSelected}
                      onChange={selection.toggleAll}
                      aria-label="Select all subscriptions on this page"
                    />
                  </th>
                )}
                {cols.show("orderId") && <th className="px-4 py-2.5">Order ID</th>}
                {cols.show("company") && <th className="px-4 py-2.5">Company</th>}
                {cols.show("subscription") && <th className="px-4 py-2.5">Subscription</th>}
                {cols.show("qty") && <th className="px-4 py-2.5">Qty</th>}
                {cols.show("po") && <th className="px-4 py-2.5">PO / Invoice #</th>}
                {cols.show("startDate") && <th className="px-4 py-2.5">Start date</th>}
                {cols.show("expiryDate") && <th className="px-4 py-2.5">Expiry date</th>}
                {cols.show("accountManager") && <th className="px-4 py-2.5">Account manager</th>}
                {cols.show("status") && <th className="px-4 py-2.5">Status</th>}
                {cols.show("actions") && <th className="px-4 py-2.5 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {renewals.map((r) => {
                const status = getRenewalStatus(r.endDate);
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    {cols.show("select") && (
                      <td className="px-4 py-2.5">
                        <Checkbox
                          checked={selection.isSelected(r.id)}
                          onChange={() => selection.toggle(r.id)}
                          aria-label={`Select ${formatOrderId(r.orderSeq)}`}
                        />
                      </td>
                    )}
                    {cols.show("orderId") && (
                      <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(r.orderSeq)}</td>
                    )}
                    {cols.show("company") && (
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/companies/${(r.endCustomer ?? r.company).id}?tab=renewals`}
                          className="font-medium text-text hover:underline"
                        >
                          {(r.endCustomer ?? r.company).name}
                        </Link>
                        {r.endCustomer && (
                          <div className="mt-0.5 text-xs text-info">
                            Renew via{" "}
                            <Link href={`/companies/${r.company.id}`} className="hover:underline">
                              {r.company.name}
                            </Link>
                          </div>
                        )}
                      </td>
                    )}
                    {cols.show("subscription") && (
                      <td className="px-4 py-2.5 text-muted">
                        {r.item.name}
                        {r.item.unit ? ` (${r.item.unit})` : ""}
                      </td>
                    )}
                    {cols.show("qty") && (
                      <td className="px-4 py-2.5 text-muted">
                        {r.group?.totalQuantity ?? r.quantity}
                        {/* Only worth saying where seats were added mid-term — otherwise it is noise. */}
                        {r.group && r.group.addonCount > 0 && (
                          <span className="block text-[11px] text-subtle" title={r.group.note}>
                            {r.quantity} + {r.group.totalQuantity - r.quantity} added
                          </span>
                        )}
                      </td>
                    )}
                    {cols.show("po") && (
                      <td className="px-4 py-2.5 text-muted">{r.poNumber ?? "—"}</td>
                    )}
                    {cols.show("startDate") && (
                      <td className="px-4 py-2.5 text-muted">{formatDate(r.startDate)}</td>
                    )}
                    {cols.show("expiryDate") && (
                      <td className="px-4 py-2.5 text-muted">{formatDate(r.endDate)}</td>
                    )}
                    {cols.show("accountManager") && (
                      <td className="px-4 py-2.5 text-muted">
                        {r.company.owner?.name ?? (
                          <span className="text-subtle">Nobody</span>
                        )}
                      </td>
                    )}
                    {cols.show("status") && (
                      <td className="px-4 py-2.5">
                        <Badge tone={status.tone}>{status.label}</Badge>
                        {r.renewedBy && (
                          <span className="mt-0.5 block text-[11px] text-success">
                            Renewed — {formatOrderId(r.renewedBy.orderSeq)}
                          </span>
                        )}
                      </td>
                    )}
                    {cols.show("actions") && (
                      <td className="px-4 py-2.5">
                        <div className="flex items-center justify-end gap-1">
                          {/* Ring them, write to them, or punch the order — the three things this
                              list exists to lead to. */}
                          <CallButton
                            companyId={r.company.id}
                            companyName={r.company.name}
                            companyProductId={r.id}
                            preferContact={r.company.contacts?.[0]}
                            size="icon"
                            variant="ghost"
                          />
                          <CustomerNoticeButton
                            companyProductId={r.id}
                            companyName={(r.endCustomer ?? r.company).name}
                          />
                          <RenewButton companyProductId={r.id} />
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
              {renewals.length === 0 && (
                <tr>
                  <td colSpan={cols.count} className="px-4 py-8 text-center text-subtle">
                    No subscriptions with an expiry date match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
