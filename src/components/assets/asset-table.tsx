import Link from "next/link";
import { Laptop, Package } from "lucide-react";
import type { listAssets } from "@/actions/it-asset";
import { Badge, Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { assetKindLabels, coverState, ownershipLabels, ownershipTone, statusLabels, statusTone } from "@/lib/assets/lifecycle";

type Asset = Awaited<ReturnType<typeof listAssets>>[number];

/**
 * The register.
 *
 * Cover is shown as one column rather than two dates, because the question people arrive with is
 * "if this breaks today, does somebody else pay" — and answering it from a warranty date and an AMC
 * date means doing the arithmetic in your head at the worst moment.
 */
export function AssetTable({ assets, emptyHint }: { assets: Asset[]; emptyHint?: string }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Tag</th>
              <th className="px-4 py-2.5">Asset</th>
              <th className="px-4 py-2.5">Whose</th>
              <th className="px-4 py-2.5">Where / who</th>
              <th className="px-4 py-2.5">Cover</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => {
              const cover = coverState(a);
              return (
                <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`/assets/${a.id}`} className="font-mono text-xs text-brand hover:underline">
                      {a.assetTag}
                    </Link>
                    {a.serialNumber && <span className="block text-[11px] text-subtle">{a.serialNumber}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-1.5 text-text">
                      {a.kind === "SOFTWARE_LICENCE" ? (
                        <Package className="h-3.5 w-3.5 shrink-0 text-subtle" />
                      ) : (
                        <Laptop className="h-3.5 w-3.5 shrink-0 text-subtle" />
                      )}
                      {a.name}
                    </span>
                    <span className="block text-xs text-subtle">
                      {assetKindLabels[a.kind]}
                      {a.make && ` · ${a.make}`}
                      {a.model && ` ${a.model}`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={ownershipTone[a.ownership]}>{ownershipLabels[a.ownership]}</Badge>
                    {a.ownerCompany && <span className="block text-xs text-subtle">{a.ownerCompany.name}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {a.custodian?.name ?? a.holder?.name ?? a.siteCompany?.name ?? "—"}
                    {a.location && <span className="block text-xs text-subtle">{a.location.label}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={cover.tone}>{cover.label}</Badge>
                    {/* Only worth the space while something is actually running out. */}
                    {cover.daysLeft !== null && cover.daysLeft >= 0 && cover.daysLeft <= 60 && (
                      <span className="block text-[11px] text-subtle">{cover.daysLeft} days left</span>
                    )}
                    {cover.key === "EXPIRED" && (a.warrantyEndsOn || a.amcEndsOn) && (
                      <span className="block text-[11px] text-subtle">
                        since {formatDate(a.amcEndsOn ?? a.warrantyEndsOn!)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={statusTone[a.status]}>{statusLabels[a.status]}</Badge>
                  </td>
                </tr>
              );
            })}
            {assets.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-subtle">
                  {emptyHint ?? "Nothing here yet."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
