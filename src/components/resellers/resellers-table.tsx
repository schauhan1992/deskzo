"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ResellerOnboardingStatus, ResellerTier } from "@prisma/client";
import { bulkUpdateResellers } from "@/actions/reseller";
import {
  resellerStatusValues,
  resellerStatusLabels,
  resellerTierValues,
  resellerTierLabels,
} from "@/lib/reseller-onboarding";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { BulkBar, Checkbox, useRowSelection } from "@/components/ui/bulk-select";
import { formatDate } from "@/lib/utils";

const STATUS_TONE: Record<ResellerOnboardingStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  ONBOARDING: "amber",
  ACTIVE: "green",
  SUSPENDED: "red",
  INACTIVE: "default",
};

type ResellerRow = {
  id: string;
  name: string;
  source: string;
  createdAt: string | Date;
  resellerProfile: { status: ResellerOnboardingStatus; tier: ResellerTier | null } | null;
  _count: { contacts: number; products: number; endCustomers: number };
  owner: { id: string; name: string } | null;
};

export function ResellersTable({ resellers }: { resellers: ResellerRow[] }) {
  const router = useRouter();
  const selection = useRowSelection(resellers);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [tier, setTier] = useState("");

  function apply() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await bulkUpdateResellers({ companyIds: selection.ids, status, tier });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const { count, blocked } = result.data;
      setNotice(`Updated ${count} reseller(s).`);
      if (blocked.length > 0) {
        setError(`Couldn't activate ${blocked.join(", ")} — their onboarding isn't complete.`);
      }
      setStatus("");
      setTier("");
      selection.clear();
      router.refresh();
    });
  }

  return (
    <div>
      <BulkBar count={selection.count} onClear={selection.clear} error={error} notice={notice}>
        {/* The bulk bar has no room for captions; the first option is a prompt, not a name. */}
        <Select
          aria-label="Onboarding status for the selected resellers"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="h-9 w-48"
        >
          <option value="">Status — no change</option>
          {resellerStatusValues.map((s) => (
            <option key={s} value={s}>
              {resellerStatusLabels[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Tier for the selected resellers"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
          className="h-9 w-44"
        >
          <option value="">Tier — no change</option>
          {resellerTierValues.map((t) => (
            <option key={t} value={t}>
              {resellerTierLabels[t]}
            </option>
          ))}
        </Select>
        <Button size="sm" disabled={isPending || (!status && !tier)} onClick={apply}>
          {isPending ? "Applying…" : "Apply"}
        </Button>
      </BulkBar>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={selection.allSelected}
                    onChange={selection.toggleAll}
                    aria-label="Select all resellers on this page"
                  />
                </th>
                <th className="px-4 py-2.5">Reseller</th>
                <th className="px-4 py-2.5">Onboarding</th>
                <th className="px-4 py-2.5">Tier</th>
                <th className="px-4 py-2.5">End customers</th>
                <th className="px-4 py-2.5">Orders</th>
                <th className="px-4 py-2.5">Contacts</th>
                <th className="px-4 py-2.5">Source</th>
                <th className="px-4 py-2.5">Account manager</th>
                <th className="px-4 py-2.5">Added on</th>
              </tr>
            </thead>
            <tbody>
              {resellers.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Checkbox
                      checked={selection.isSelected(r.id)}
                      onChange={() => selection.toggle(r.id)}
                      aria-label={`Select ${r.name}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/companies/${r.id}`} className="font-medium text-text hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    {r.resellerProfile ? (
                      <Badge tone={STATUS_TONE[r.resellerProfile.status]}>
                        {resellerStatusLabels[r.resellerProfile.status]}
                      </Badge>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {r.resellerProfile?.tier ? resellerTierLabels[r.resellerProfile.tier] : "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    {r._count.endCustomers > 0 ? (
                      <Badge tone="blue">{r._count.endCustomers}</Badge>
                    ) : (
                      <span className="text-subtle">None yet</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{r._count.products}</td>
                  <td className="px-4 py-2.5 text-muted">{r._count.contacts}</td>
                  <td className="px-4 py-2.5 text-muted">{r.source}</td>
                  <td className="px-4 py-2.5 text-muted">{r.owner?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
              {resellers.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-subtle">
                    No resellers yet.
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
