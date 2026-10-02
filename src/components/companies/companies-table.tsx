"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CompanyStage, CompanyRelationshipType, VendorStatus } from "@prisma/client";
import { bulkUpdateCompanies } from "@/actions/company";
import { relationshipTypeLabels, vendorStatusLabels, vendorStatusValues } from "@/lib/validation/company";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { useColumns } from "@/components/ui/table-columns";
import { formatCompanyId } from "@/lib/order-id";
import { PORTAL_STATE_LABEL, type PortalState } from "@/lib/portal/state-labels";
import { CategoryIcon } from "@/components/customers/category-chip";
import type { CategoryWithParent } from "@/lib/customers/categories";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";

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
  /** The short reference people quote — COM-000123. `id` is a cuid, which nobody can read out. */
  companySeq: number;
  name: string;
  stage: CompanyStage;
  relationshipType: CompanyRelationshipType;
  vendorStatus?: VendorStatus | null;
  source: string;
  createdAt: string | Date;
  _count: { contacts: number; leads: number; products?: number };
  owner: { id: string; name: string } | null;
  createdBy: { id: string; name: string };
  assignedTo: { id: string; name: string } | null;
  /** Where the customer sits — its icon goes beside the name. Absent on the vendor lists. */
  customerCategory?: CategoryWithParent | null;
  /**
   * Resolved by the page, not here.
   *
   * It depends on the global portal settings, and a client component asking the server per row is
   * fifty round trips to paint one column. Absent means "this list did not ask", and the column is
   * then never drawn — see the guards below.
   */
  portal?: PortalState | null;
};

/** A won deal (`stage: "CUSTOMER"`) only counts as a real Customer once it has at least one order on file — otherwise it's a closed deal still awaiting its first order to be punched in. */
function stageDisplay(c: CompanyRow): { label: string; tone: "default" | "green" | "blue" | "red" | "amber" } {
  if (c.stage === "CUSTOMER" && (c._count.products ?? 0) === 0) {
    return { label: "Awaiting Order", tone: "amber" };
  }
  return { label: c.stage, tone: STAGE_TONE[c.stage] };
}

type AssignableUser = { id: string; name: string; role: string };

export function CompaniesTable({
  companies,
  assignableUsers,
  mode = "companies",
  reassign,
  customColumns = { columns: [], texts: {} },
}: {
  companies: CompanyRow[];
  assignableUsers: AssignableUser[];
  /** Whether this person may change callers at all, and leave them with nobody — see src/lib/authz/reassign.ts. */
  reassign: { show: boolean; canUnassign: boolean };
  mode?: "companies" | "vendors" | "customers" | "commission-parties";
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`),
   * after the registered columns: the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const router = useRouter();
  const selection = useRowSelection(companies);
  const [assignTo, setAssignTo] = useState("");
  const [vendorStatus, setVendorStatus] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const hasOnboardingStatusColumn = mode === "vendors" || mode === "commission-parties";
  // Keyed on the mode, so each of the four lists this component renders remembers its own
  // columns. They are not the same table: Customers has no Leads column and counts orders where
  // the sourcing pool shows pipeline stage, so one shared preference would put a Leads entry in a
  // picker on a screen that has none.
  const cols = useColumns(mode);
  // No adjustment needed: `leads` is simply absent from every registry but Companies, so
  // `cols.show("leads")` is already false elsewhere and the count is already right.
  /**
   * Whether this list computed portal state at all.
   *
   * Companies, Customers and Vendors share this component but not their queries — only the pages
   * that ask for it pass it through. Without this the column would be drawn full of dashes on the
   * lists that never looked.
   */
  const hasPortalData = companies.some((c) => c.portal !== undefined);
  // The empty-state colspan has to match what is actually drawn, not what the registry allows.
  const columnCount = cols.count - (cols.show("portal") && !hasPortalData ? 1 : 0);
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  const emptyText =
    mode === "vendors"
      ? "No vendors yet."
      : mode === "commission-parties"
        ? "No commission parties yet."
        : mode === "customers"
          ? "No customers yet."
          : "No companies yet.";
  // "Caller" (lead generation) only makes sense for Companies/Customer — Vendors/Commission Parties
  // keep the generic "Assigned to" wording, since that assignment isn't about calling to generate a sales lead.
  const assignedColumnLabel = hasOnboardingStatusColumn ? "Assigned to" : "Caller";
  const assignActionLabel = hasOnboardingStatusColumn ? "Assign to…" : "Assign caller…";

  const addTags = tagInput
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const hasChanges = !!assignTo || !!vendorStatus || addTags.length > 0;

  function apply() {
    if (!hasChanges || selection.count === 0) return;
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateCompanies({
        companyIds: selection.ids,
        assignedToUserId: assignTo,
        vendorStatus,
        addTags,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice(`Updated ${result.data.count} record(s).`);
      selection.clear();
      setAssignTo("");
      setVendorStatus("");
      setTagInput("");
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* The bulk bar has no room for captions — each control's own placeholder or first option is
            the only wording on screen, so the name has to be carried on the control itself. */}
        {/* Only for somebody who may change callers — a picker that only ever refuses is worse than none. */}
        {reassign.show && (
          <Select
            value={assignTo}
            onChange={(e) => setAssignTo(e.target.value)}
            aria-label="Assign selected companies to"
            className="h-9 w-56"
          >
            <option value="">{assignActionLabel}</option>
            {reassign.canUnassign && <option value="unassign">Unassign</option>}
            {assignableUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.role})
              </option>
            ))}
          </Select>
        )}
        {hasOnboardingStatusColumn && (
          <Select
            value={vendorStatus}
            onChange={(e) => setVendorStatus(e.target.value)}
            aria-label="Set onboarding status"
            className="h-9 w-52"
          >
            <option value="">Onboarding — no change</option>
            {vendorStatusValues.map((v) => (
              <option key={v} value={v}>
                {vendorStatusLabels[v]}
              </option>
            ))}
          </Select>
        )}
        <Input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="Add tags (comma separated)"
          aria-label="Add tags (comma separated)"
          className="h-9 w-56"
        />
        <Button size="sm" disabled={!hasChanges || isPending} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                {cols.show("select") && (
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox
                      checked={selection.allSelected}
                      onChange={selection.toggleAll}
                      aria-label="Select all rows on this page"
                    />
                  </th>
                )}
                {cols.show("id") && <th className="px-4 py-2.5">ID</th>}
                {cols.show("company") && <th className="px-4 py-2.5">Company</th>}
                {cols.show("status") &&
                  (hasOnboardingStatusColumn ? (
                    <th className="px-4 py-2.5">Onboarding status</th>
                  ) : mode === "customers" ? (
                    <th className="px-4 py-2.5">Orders</th>
                  ) : (
                    <th className="px-4 py-2.5">Stage</th>
                  ))}
                {cols.show("relationship") && <th className="px-4 py-2.5">Relationship</th>}
                {cols.show("source") && <th className="px-4 py-2.5">Source</th>}
                {cols.show("contacts") && <th className="px-4 py-2.5">Contacts</th>}
                {cols.show("leads") && <th className="px-4 py-2.5">Leads</th>}
                {cols.show("assigned") && <th className="px-4 py-2.5">{assignedColumnLabel}</th>}
                {cols.show("portal") && hasPortalData && <th className="px-4 py-2.5">Portal</th>}
                {cols.show("addedBy") && <th className="px-4 py-2.5">Added by</th>}
                {cols.show("addedOn") && <th className="px-4 py-2.5">Added on</th>}
                <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  {cols.show("select") && (
                    <td className="px-4 py-2.5">
                      <Checkbox
                        checked={selection.isSelected(c.id)}
                        onChange={() => selection.toggle(c.id)}
                        aria-label={`Select ${c.name}`}
                      />
                    </td>
                  )}
                  {/* One sequence across all four lists, so a customer and a vendor can never
                      carry the same number. */}
                  {cols.show("id") && (
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatCompanyId(c.companySeq)}</td>
                  )}
                  {cols.show("company") && (
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <CategoryIcon category={c.customerCategory} />
                        <Link href={`/companies/${c.id}`} className="font-medium text-text hover:underline">
                          {c.name}
                        </Link>
                      </span>
                    </td>
                  )}
                  {cols.show("status") &&
                    (hasOnboardingStatusColumn ? (
                      <td className="px-4 py-2.5">
                        {c.vendorStatus ? (
                          <Badge tone={VENDOR_STATUS_TONE[c.vendorStatus]}>{vendorStatusLabels[c.vendorStatus]}</Badge>
                        ) : (
                          "—"
                        )}
                      </td>
                    ) : mode === "customers" ? (
                      <td className="px-4 py-2.5 text-muted">{c._count.products ?? 0}</td>
                    ) : (
                      <td className="px-4 py-2.5">
                        <Badge tone={stageDisplay(c).tone}>{stageDisplay(c).label}</Badge>
                      </td>
                    ))}
                  {cols.show("relationship") && (
                    <td className="px-4 py-2.5 text-muted">{relationshipTypeLabels[c.relationshipType]}</td>
                  )}
                  {cols.show("source") && <td className="px-4 py-2.5 text-muted">{c.source}</td>}
                  {cols.show("contacts") && <td className="px-4 py-2.5 text-muted">{c._count.contacts}</td>}
                  {cols.show("leads") && (
                    <td className="px-4 py-2.5 text-muted">{c._count.leads}</td>
                  )}
                  {cols.show("assigned") && (
                    <td className="px-4 py-2.5 text-muted">{c.assignedTo?.name ?? "—"}</td>
                  )}
                  {cols.show("portal") && hasPortalData && (
                    <td className="px-4 py-2.5">
                      {c.portal ? (
                        <Badge tone={PORTAL_STATE_LABEL[c.portal.kind].tone} title={PORTAL_STATE_LABEL[c.portal.kind].hint}>
                          {c.portal.kind === "on"
                            ? `On · ${c.portal.links}`
                            : PORTAL_STATE_LABEL[c.portal.kind].label}
                        </Badge>
                      ) : (
                        <span className="text-subtle">—</span>
                      )}
                    </td>
                  )}
                  {cols.show("addedBy") && <td className="px-4 py-2.5 text-muted">{c.createdBy.name}</td>}
                  {cols.show("addedOn") && (
                    <td className="px-4 py-2.5 text-muted">
                      {new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(new Date(c.createdAt))}
                    </td>
                  )}
                  <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[c.id]} className="px-4 py-2.5 text-muted" />
                </tr>
              ))}
              {companies.length === 0 && (
                <tr>
                  <td colSpan={columnCount + fieldColumns.length} className="px-4 py-8 text-center text-subtle">
                    {emptyText}
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
