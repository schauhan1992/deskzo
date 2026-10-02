"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MailCheck, MessageCircle } from "lucide-react";
import type { ContactDesignation, CompanyRelationshipType } from "@prisma/client";
import { bulkUpdateContacts } from "@/actions/contact";
import { verifyContactEmails } from "@/actions/email-verification";
import { contactDesignationValues, relationshipTypeLabels } from "@/lib/validation/company";
import { Badge, Card } from "@/components/ui/card";
import { CallButton } from "@/components/calls/call-button";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { EmailAddress, type VerifiableContact } from "@/components/contacts/email-address";
import { OutboundLink, whatsappHref } from "@/components/ui/outbound-link";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";

type ContactRow = VerifiableContact & {
  name: string;
  designation: ContactDesignation;
  phone: string | null;
  isPrimary: boolean;
  company: {
    id: string;
    name: string;
    relationshipType: CompanyRelationshipType;
    industry: { id: string; name: string } | null;
  };
};

export function ContactsTable({
  contacts,
  customColumns = { columns: [], texts: {} },
}: {
  contacts: ContactRow[];
  /** The workspace's own fields marked "a column in the list" (src/lib/custom-fields/server.ts `listColumns`, `listedOnly`): no column picker here. */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const router = useRouter();
  const selection = useRowSelection(contacts);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [designation, setDesignation] = useState("");

  function run(action: "update" | "delete") {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateContacts({ contactIds: selection.ids, designation, action });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, skipped } = result.data;
      setNotice(
        action === "delete"
          ? `Deleted ${count} contact(s).${skipped > 0 ? ` ${skipped} kept — they're linked to a lead.` : ""}`
          : `Updated ${count} contact(s).`,
      );
      setDesignation("");
      selection.clear();
      router.refresh();
    });
  }

  /**
   * Checks every selected address. The selection is kept afterwards rather than cleared: the point
   * of running it is to look at what came back, and losing the rows would defeat that.
   */
  function verifySelected() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await verifyContactEmails(selection.ids);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { checked, skipped, results } = result.data;
      const bad = results.filter((r) => r.status === "INVALID").length;
      const risky = results.filter((r) => r.status === "RISKY").length;
      setNotice(
        `Checked ${checked}.` +
          (bad > 0 ? ` ${bad} won't deliver.` : "") +
          (risky > 0 ? ` ${risky} reach a shared or personal inbox.` : "") +
          (skipped > 0 ? ` ${skipped} had no address.` : ""),
      );
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* No caption in the bulk bar — the name rides on the control. */}
        <Select
          value={designation}
          onChange={(e) => setDesignation(e.target.value)}
          className="h-9 w-52"
          aria-label="Designation"
        >
          <option value="">Designation — no change</option>
          {contactDesignationValues.map((d) => (
            <option key={d} value={d}>
              {d.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={!designation || isPending} onClick={() => run("update")}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
        <Button size="sm" variant="secondary" disabled={isPending} onClick={verifySelected}>
          <MailCheck className="mr-1.5 h-3.5 w-3.5" />
          Verify emails
        </Button>
        <Button
          size="sm"
          variant="danger"
          disabled={isPending}
          onClick={() => {
            if (confirm(`Delete ${selection.count} contact(s)? This can't be undone.`)) run("delete");
          }}
        >
          Delete
        </Button>
      </BulkBar>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    aria-label="Select all contacts on this page"
                  />
                </th>
                <th className="px-4 py-2.5">Name</th>
                <th className="px-4 py-2.5">Designation</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Relationship</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Phone</th>
                <CustomFieldHeaderCells columns={customColumns.columns} className="px-4 py-2.5" />
                <th className="px-4 py-2.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(c.id)}
                      onChange={() => selection.toggle(c.id)}
                      aria-label={`Select ${c.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="font-medium text-text">{c.name}</span>
                    {c.isPrimary && (
                      <Badge tone="blue" className="ml-2">
                        Primary
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.designation.replaceAll("_", " ")}</td>
                  <td className="px-4 py-2.5">
                    <Link href={`/companies/${c.company.id}?tab=contacts`} className="text-text hover:underline">
                      {c.company.name}
                    </Link>
                    {c.company.industry && <div className="text-xs text-subtle">{c.company.industry.name}</div>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{relationshipTypeLabels[c.company.relationshipType]}</td>
                  <td className="px-4 py-2.5 text-muted">
                    <EmailAddress contact={c} className="max-w-[16rem]" />
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.phone ?? "—"}</td>
                  <CustomFieldBodyCells columns={customColumns.columns} texts={customColumns.texts[c.id]} className="px-4 py-2.5 text-muted" />
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      {c.phone && (
                        <CallButton
                          companyId={c.company.id}
                          companyName={c.company.name}
                          contact={{ id: c.id, name: c.name, phone: c.phone }}
                          size="icon"
                          variant="ghost"
                        />
                      )}
                      {c.phone && (
                        <OutboundLink
                          href={whatsappHref(c.phone)}
                          title="WhatsApp"
                          className="text-success hover:text-success"
                        >
                          <MessageCircle className="h-4 w-4" />
                        </OutboundLink>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {contacts.length === 0 && (
                <tr>
                  <td colSpan={8 + customColumns.columns.length} className="px-4 py-8 text-center text-subtle">
                    No contacts match this filter.
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
