import type { ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, PackageSearch, Truck } from "lucide-react";
import { assetFormOptions, companyEstate } from "@/actions/it-asset";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { AssetTable } from "@/components/assets/asset-table";
import { NewAssetDialog } from "@/components/assets/new-asset-dialog";
import {
  consignmentReasonLabels,
  consignmentStatusLabels,
  consignmentStatusTone,
  coverState,
  isMoving,
  movementLabels,
  statusLabels,
} from "@/lib/assets/lifecycle";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * What we look after for one company, on that company's own page.
 *
 * Whoever opens this arrives with one of three questions, and the page answers them in that order:
 * what have we got of theirs, is any of it about to fall out of cover, and where is the machine they
 * rang about. Splitting the estate by *whose it is* is not presentation — it decides who pays when
 * something breaks, and whether the machine belongs on our balance sheet at all.
 */
export async function CompanyEstate({ companyId, companyName }: { companyId: string; companyName: string }) {
  const estate = await companyEstate(companyId);
  if (!estate) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-subtle">
          You don&apos;t have access to the asset register.
        </CardContent>
      </Card>
    );
  }

  const { theirs, ours, away, consignments, canManage } = estate;
  const options = canManage ? await assetFormOptions() : null;

  const everything = [...theirs, ...ours, ...away];
  const cover = everything.map((a) => ({ asset: a, state: coverState(a) }));
  const lapsed = cover.filter((c) => c.state.key === "EXPIRED");
  const expiring = cover.filter((c) => c.state.daysLeft !== null && c.state.daysLeft >= 0 && c.state.daysLeft <= 30);
  const uncovered = cover.filter((c) => c.state.key === "NONE");
  const onTheRoad = consignments.filter((c) => isMoving(c.status));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Everything on the register that touches {companyName} — their own equipment we look after, ours standing at
          their site, and whatever is on the road between us. A client&apos;s machine never reaches our balance sheet,
          however much of it we manage.
        </p>
        {options && (
          <NewAssetDialog
            options={options}
            preset={{ companyId, companyName, ownership: "CLIENT_OWNED" }}
            label="Add to their estate"
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Theirs, managed" value={theirs.length} hint="their property, our responsibility" />
        <Stat label="Ours at their site" value={ours.length} hint="still our balance sheet" />
        <Stat
          label="Cover running out"
          value={lapsed.length + expiring.length}
          hint={lapsed.length + expiring.length > 0 ? "lapsed, or inside 30 days" : "nothing expiring"}
        />
        <Stat
          label="On the road"
          value={onTheRoad.length + away.length}
          hint={onTheRoad.length + away.length > 0 ? "in transit or away for repair" : "nothing in motion"}
        />
      </div>

      {/* Lapsed cover is the one thing on this page that costs money the moment it becomes true:
          work we are doing, or about to do, that nobody is paying for. */}
      {(lapsed.length > 0 || uncovered.length > 0) && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3">
          <div className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-1">
              {lapsed.length > 0 && (
                <p>
                  <span className="font-medium">
                    {lapsed.length} {lapsed.length === 1 ? "asset is" : "assets are"} out of cover
                  </span>{" "}
                  —{" "}
                  {lapsed
                    .slice(0, 4)
                    .map((c) => c.asset.assetTag)
                    .join(", ")}
                  {lapsed.length > 4 && ` and ${lapsed.length - 4} more`}. Either an AMC renewal is overdue, or the
                  next call-out is chargeable.
                </p>
              )}
              {uncovered.length > 0 && (
                <p>
                  {uncovered.length} {uncovered.length === 1 ? "has" : "have"} no warranty or AMC date recorded at all.
                  That is a gap in the record rather than a gap in cover — but nobody can answer &ldquo;is this
                  covered&rdquo; from it.
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      <Section
        title="Their equipment"
        subtitle="Owned by them, managed by us. Never capitalised here, whatever we spend looking after it."
        count={theirs.length}
      >
        <AssetTable
          assets={theirs}
          emptyHint={`Nothing of ${companyName}'s is on the register yet. Add their machines to track warranty, AMC cover and who is holding what.`}
        />
      </Section>

      {ours.length > 0 && (
        <Section
          title="Ours, at their site"
          subtitle="Rented, loaned or standing in. It stays on our books, and it has to come back."
          count={ours.length}
        >
          <AssetTable assets={ours} />
        </Section>
      )}

      {/* This list exists because `siteCompanyId` follows the machine: send one out for repair and it
          silently leaves the site list above — which is exactly when the customer rings about it. */}
      {away.length > 0 && (
        <Section
          title="Away from their site"
          subtitle="Off being repaired, or on the road. Still theirs to ask about."
          count={away.length}
        >
          <Card className="overflow-hidden p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2.5">Tag</th>
                    <th className="px-4 py-2.5">Asset</th>
                    <th className="px-4 py-2.5">Left on</th>
                    <th className="px-4 py-2.5">Gone to</th>
                    <th className="px-4 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {away.map((a) => {
                    const last = a.movements[0];
                    return (
                      <tr key={a.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                        <td className="px-4 py-2.5">
                          <Link href={`/assets/${a.id}`} className="font-mono text-xs text-brand hover:underline">
                            {a.assetTag}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 text-text">{a.name}</td>
                        <td className="px-4 py-2.5 text-muted">
                          {last ? formatDate(last.occurredAt) : "—"}
                          {last && <span className="block text-xs text-subtle">{movementLabels[last.type]}</span>}
                        </td>
                        <td className="px-4 py-2.5 text-muted">{last?.toCompany?.name ?? last?.toLabel ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          <Badge tone="amber">{statusLabels[a.status]}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </Section>
      )}

      <Section
        title="Deliveries and collections"
        subtitle="Every consignment sent to them, with the docket and the paperwork that travelled with it."
        count={consignments.length}
      >
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5">Consignment</th>
                  <th className="px-4 py-2.5">What for</th>
                  <th className="px-4 py-2.5">Where</th>
                  <th className="px-4 py-2.5">Courier</th>
                  <th className="px-4 py-2.5">Dates</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {consignments.map((c) => (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="px-4 py-2.5">
                      <Link href={`/logistics/${c.id}`} className="font-mono text-xs text-brand hover:underline">
                        {c.consignmentNumber}
                      </Link>
                      <span className="block text-[11px] text-subtle">
                        {c._count.movements} {c._count.movements === 1 ? "item" : "items"}
                        {c.declaredValue ? ` · ${formatCurrency(c.declaredValue)}` : ""}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {consignmentReasonLabels[c.reason]}
                      {c.document && (
                        <Link
                          href={`/documents/${c.document.id}`}
                          className="block text-[11px] text-brand hover:underline"
                        >
                          {c.document.docNumber}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {c.toLocation?.label ?? "—"}
                      {c.toContact && <span className="block text-xs text-subtle">c/o {c.toContact.name}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {c.courier ?? "—"}
                      {c.docketNumber && (
                        <span className="block font-mono text-[11px] text-subtle">{c.docketNumber}</span>
                      )}
                      {c.ewayBillNumber && <span className="block text-[11px] text-subtle">EWB {c.ewayBillNumber}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {c.dispatchedOn ? `Sent ${formatDate(c.dispatchedOn)}` : "Not sent yet"}
                      {c.deliveredOn ? (
                        <span className="block text-xs text-subtle">
                          Received {formatDate(c.deliveredOn)}
                          {c.receivedBy ? ` by ${c.receivedBy}` : ""}
                        </span>
                      ) : (
                        c.expectedOn && <span className="block text-xs text-subtle">Due {formatDate(c.expectedOn)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={consignmentStatusTone[c.status]}>{consignmentStatusLabels[c.status]}</Badge>
                    </td>
                  </tr>
                ))}
                {consignments.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-subtle">
                      <PackageSearch className="mx-auto mb-2 h-5 w-5" />
                      Nothing has been shipped to {companyName} yet. Consignments raised on the Logistics page show up
                      here with their docket and e-way bill.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </Section>

      {onTheRoad.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Truck className="h-3.5 w-3.5" />
          {onTheRoad.length} {onTheRoad.length === 1 ? "consignment is" : "consignments are"} still moving. Nobody has
          signed for them yet.
        </p>
      )}
    </div>
  );
}

function Section({
  title,
  subtitle,
  count,
  children,
}: {
  title: string;
  subtitle: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-text">
        {title}
        <span className="ml-2 font-normal tabular-nums text-subtle">{count}</span>
      </h3>
      <p className="text-xs text-muted">{subtitle}</p>
      {children}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
