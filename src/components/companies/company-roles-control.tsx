"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCompanySecondRole, setCompanySideOwner } from "@/actions/company";
import type { CompanySide } from "@/lib/companies/roles";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";

/**
 * A company's roles (owner, 19 Oct 2026 — src/lib/companies/roles.ts): its main kind, and the other side
 * it may also be — a vendor that buys from us, a customer we buy from — with whoever looks after that side.
 */
export function CompanyRolesControl({
  companyId,
  mainLabel,
  added,
  addable,
  sideOwnerId,
  people,
  canEdit,
}: {
  companyId: string;
  mainLabel: string;
  added: CompanySide | null;
  addable: CompanySide[];
  sideOwnerId: string | null;
  people: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const manager = added === "vendor" ? "Vendor manager" : "Account manager";

  const run = (work: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Roles</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="text-muted">Main role</span>
          <span className="text-text">{mainLabel}</span>
        </div>
        {added ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-muted">Also</span>
              <span className="text-text">{added === "vendor" ? "A vendor — we buy from them too" : "A customer — they buy from us too"}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <label htmlFor="side-owner" className="text-muted">
                {manager}
              </label>
              {canEdit ? (
                <Select
                  id="side-owner"
                  className="h-8 w-56 text-sm"
                  value={sideOwnerId ?? ""}
                  disabled={pending}
                  onChange={(e) => run(() => setCompanySideOwner({ companyId, userId: e.target.value || null }))}
                >
                  <option value="">Nobody in particular</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-text">{people.find((p) => p.id === sideOwnerId)?.name ?? "Nobody in particular"}</span>
              )}
            </div>
            <p className="text-xs text-muted">
              It&apos;s in both lists and both sides&apos; pickers. {added === "vendor" ? "Purchasing" : "Sales"} reach it through the {manager.toLowerCase()}, as
              they reach their own {added === "vendor" ? "vendors" : "customers"}.
            </p>
            {canEdit && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={pending}
                onClick={() => {
                  if (window.confirm(`Stop treating it as a ${added}? What was done as one stays; it's just no longer offered as one.`)) {
                    run(() => setCompanySecondRole({ companyId, side: added, on: false }));
                  }
                }}
              >
                {added === "vendor" ? "No longer a vendor" : "No longer a customer"}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-xs text-muted">
              One company, two roles: a vendor that also buys from you, or a customer you also buy from, stays one record — one set of contacts,
              addresses and GSTIN — in both lists.
            </p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {addable.map((side) => (
                  <Button key={side} type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run(() => setCompanySecondRole({ companyId, side, on: true }))}>
                    {side === "vendor" ? "Add as a vendor too" : "Add as a customer too"}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
