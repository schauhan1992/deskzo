"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ShieldCheck, Users2 } from "lucide-react";
import type { TradeDocumentType } from "@prisma/client";
import { saveApprovalPolicy } from "@/actions/document-approval";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label } from "@/components/ui/input";

export type PolicyRow = {
  docType: TradeDocumentType;
  enabled: boolean;
  approverRoles: string[];
  approverUserIds: string[];
  managerApproves: boolean;
  minValue: number | null;
  maxDiscountPercent: number | null;
  approvers: { id: string; name: string }[];
  updatedBy: string | null;
};

/**
 * Who signs off each kind of document.
 *
 * One card per document type rather than one global switch, because the answer genuinely differs: a
 * quotation commits a price and belongs to whoever runs the desk; a tax invoice posts to the ledger
 * and files with the government and belongs to accounts. A single setting would force the stricter
 * of the two onto both.
 *
 * Everything is off to begin with, so this screen changes nothing until somebody deliberately turns
 * a type on.
 */
export function ApprovalPolicies({
  policies,
  roles,
  users,
}: {
  policies: PolicyRow[];
  roles: { key: string; name: string }[];
  users: { id: string; name: string; role: string }[];
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex gap-3 py-3 text-xs text-muted">
          <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div className="space-y-1">
            <p>
              A document of a switched-on type can be drafted and edited freely, but{" "}
              <strong className="text-text">cannot be issued</strong> until somebody signs it off. Issuing is the
              irreversible step — it commits the number to a GST series and, for an invoice, files with the portal.
            </p>
            <p>
              Two rules are not configurable: <strong className="text-text">nobody approves what they submitted</strong>,
              and editing an approved document sends it back for approval, because it is no longer the document that was
              approved.
            </p>
          </div>
        </CardContent>
      </Card>

      {policies.map((policy) => (
        <PolicyCard key={policy.docType} policy={policy} roles={roles} users={users} />
      ))}
    </div>
  );
}

function PolicyCard({
  policy,
  roles,
  users,
}: {
  policy: PolicyRow;
  roles: { key: string; name: string }[];
  users: { id: string; name: string; role: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [enabled, setEnabled] = useState(policy.enabled);
  const [approverRoles, setApproverRoles] = useState<string[]>(policy.approverRoles);
  const [approverUserIds, setApproverUserIds] = useState<string[]>(policy.approverUserIds);
  const [managerApproves, setManagerApproves] = useState(policy.managerApproves);
  // Kept as text while typing; blank means "no such rule".
  const [minValue, setMinValue] = useState(policy.minValue === null ? "" : String(policy.minValue));
  const [maxDiscount, setMaxDiscount] = useState(policy.maxDiscountPercent === null ? "" : String(policy.maxDiscountPercent));
  const asNumber = (text: string) => (text.trim() === "" ? null : Number(text));

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const dirty =
    enabled !== policy.enabled ||
    managerApproves !== policy.managerApproves ||
    approverRoles.slice().sort().join() !== policy.approverRoles.slice().sort().join() ||
    approverUserIds.slice().sort().join() !== policy.approverUserIds.slice().sort().join() ||
    asNumber(minValue) !== policy.minValue ||
    asNumber(maxDiscount) !== policy.maxDiscountPercent;

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveApprovalPolicy({
        docType: policy.docType,
        enabled,
        approverRoles,
        approverUserIds,
        managerApproves,
        minValue: asNumber(minValue),
        maxDiscountPercent: asNumber(maxDiscount),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-text">{tradeDocumentLabels[policy.docType]}</div>
          <div className="mt-0.5 text-xs text-muted">
            {!enabled
              ? "Issued without approval."
              : policy.minValue === null && policy.maxDiscountPercent === null
                ? "Every one needs approval before it can be issued."
                : `Needs approval ${[
                    policy.minValue !== null ? `above ₹${policy.minValue.toLocaleString("en-IN")}` : null,
                    policy.maxDiscountPercent !== null ? `when a line is discounted over ${policy.maxDiscountPercent}%` : null,
                  ]
                    .filter(Boolean)
                    .join(", or ")}.`}
            {policy.updatedBy && <span className="text-subtle"> · last changed by {policy.updatedBy}</span>}
          </div>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
          <Checkbox
            checked={enabled}
            onChange={() => setEnabled((v) => !v)}
            aria-label={`Require approval for ${tradeDocumentLabels[policy.docType].toLowerCase()}s`}
          />
          Require approval
        </label>
      </CardHeader>

      {enabled && (
        <CardContent className="space-y-4">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-subtle">Which ones need it</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`${policy.docType}-min-value`} className="text-xs">
                  Only when worth more than (₹)
                </Label>
                <Input
                  id={`${policy.docType}-min-value`}
                  type="number"
                  min={0}
                  step="1000"
                  inputMode="numeric"
                  placeholder="Every one"
                  value={minValue}
                  onChange={(e) => setMinValue(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${policy.docType}-max-discount`} className="text-xs">
                  Or when any line is discounted more than (%)
                </Label>
                <Input
                  id={`${policy.docType}-max-discount`}
                  type="number"
                  min={0}
                  max={100}
                  step="0.5"
                  inputMode="decimal"
                  placeholder="No discount rule"
                  value={maxDiscount}
                  onChange={(e) => setMaxDiscount(e.target.value)}
                />
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-subtle">
              Leave both blank and every one needs approving. The value is the document&apos;s total including GST, in
              rupees; exactly at the limit goes through without it. A document that breaks either rule needs approving —
              the discount rule catches the small quote given away at a loss, which a value limit alone lets through. Set
              only the discount and just heavily discounted ones need it, whatever their size.
            </p>
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-subtle">Anyone holding these roles</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {roles.map((role) => {
                const on = approverRoles.includes(role.key);
                return (
                  <button
                    key={role.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setApproverRoles((list) => toggle(list, role.key))}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      on
                        ? "border-brand bg-brand text-brand-contrast"
                        : "border-line-strong text-muted hover:bg-surface-sunken"
                    }`}
                  >
                    {role.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-subtle">
              Follows the job rather than the person, so it survives somebody leaving.
            </p>
          </div>

          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-subtle">And these people by name</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {users.map((person) => {
                const on = approverUserIds.includes(person.id);
                return (
                  <button
                    key={person.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setApproverUserIds((list) => toggle(list, person.id))}
                    className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                      on
                        ? "border-brand bg-brand text-brand-contrast"
                        : "border-line-strong text-muted hover:bg-surface-sunken"
                    }`}
                  >
                    {person.name}
                  </button>
                );
              })}
            </div>
            <p className="mt-1.5 text-[11px] text-subtle">
              Precise, and the right answer when only two people may sign off — but it needs maintaining by hand.
            </p>
          </div>

          <div>
            <label className="flex cursor-pointer items-start gap-2">
              <Checkbox
                checked={managerApproves}
                onChange={() => setManagerApproves((v) => !v)}
                aria-label="The submitter's manager can approve"
                className="mt-0.5"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm text-text">
                  <Users2 aria-hidden className="h-3.5 w-3.5" />
                  The submitter&apos;s manager can approve
                </span>
                <span className="mt-0.5 block text-[11px] text-subtle">
                  The only one of the three that names a different person per document — Rahul&apos;s goes to his
                  manager, Sana&apos;s goes to hers. Follows the reporting line already on each person&apos;s record,
                  and anyone above them in it can approve too, so one person being on leave doesn&apos;t strand a
                  quotation.
                </span>
              </span>
            </label>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}
        </CardContent>
      )}

      {(dirty || error) && (
        <CardContent className="flex items-center justify-end gap-2 border-t border-line pt-3">
          {saved && !dirty && (
            <span className="flex items-center gap-1 text-xs text-success">
              <Check className="h-3.5 w-3.5" /> Saved
            </span>
          )}
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
