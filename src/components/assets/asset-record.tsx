"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Eye, EyeOff, ShieldAlert, Ticket as TicketIcon } from "lucide-react";
import type { AssetMovementType } from "@prisma/client";
import type { getAsset } from "@/actions/it-asset";
import { locationsFor, moveAsset } from "@/actions/it-asset";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import {
  assetKindLabels,
  canMove,
  coverState,
  movementLabels,
  ownershipLabels,
  ownershipTone,
  statusAfter,
  statusLabels,
  statusTone,
} from "@/lib/assets/lifecycle";

type Asset = NonNullable<Awaited<ReturnType<typeof getAsset>>>;

/** What can sensibly be done next, in the order somebody would reach for them. */
const MOVES: AssetMovementType[] = [
  "ASSIGNED",
  "RETURNED",
  "SENT_FOR_REPAIR",
  "BACK_FROM_REPAIR",
  "TRANSFERRED",
  "SCRAPPED",
  "LOST",
];

export function AssetRecord({
  asset,
  canManage,
  people,
  companies,
}: {
  asset: Asset;
  canManage: boolean;
  people: { id: string; name: string }[];
  companies: { id: string; name: string }[];
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState<AssetMovementType | null>(null);
  const [showKey, setShowKey] = useState(false);

  const cover = coverState(asset);
  const clientOwned = asset.ownership === "CLIENT_OWNED";

  return (
    <div className="space-y-4">
      <div>
        <Link href="/assets" className="text-sm text-muted hover:text-text">
          ← IT assets
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">{asset.name}</h1>
          <span className="font-mono text-sm text-subtle">{asset.assetTag}</span>
          <Badge tone={statusTone[asset.status]}>{statusLabels[asset.status]}</Badge>
          <Badge tone={ownershipTone[asset.ownership]}>{ownershipLabels[asset.ownership]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          {assetKindLabels[asset.kind]}
          {asset.make && ` · ${asset.make}`}
          {asset.model && ` ${asset.model}`}
          {asset.serialNumber && ` · S/N ${asset.serialNumber}`}
        </p>
      </div>

      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}

      {/* Said plainly, because it's the fact that governs everything else about this record. */}
      {clientOwned && (
        <Card className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm text-muted">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-subtle" />
          This belongs to{" "}
          <Link href={`/companies/${asset.ownerCompany?.id}`} className="text-brand hover:underline">
            {asset.ownerCompany?.name}
          </Link>
          . We look after it — it carries no financial record and never appears on our balance sheet.
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Where it is</CardHeader>
            <CardContent className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Fact label="Held by" value={asset.custodian?.name ?? asset.holder?.name ?? "Nobody"} />
              <Fact
                label="At"
                value={asset.siteCompany?.name ?? (asset.status === "IN_STOCK" ? "Our office" : "—")}
              />
              <Fact label="Site" value={asset.location?.label ?? "—"} />
              <Fact label="Bought" value={asset.purchasedOn ? formatCalendarDay(asset.purchasedOn) : "—"} />
              <Fact
                label="Cost"
                value={asset.purchaseCost ? formatCurrency(Number(asset.purchaseCost)) : "—"}
              />
              <Fact label="From" value={asset.vendorCompany?.name ?? "—"} />
            </CardContent>
            {asset.specification && (
              <CardContent className="border-t border-line pt-3 text-sm text-muted">{asset.specification}</CardContent>
            )}
            {asset.notes && (
              <CardContent className="border-t border-line pt-3 text-sm text-muted">{asset.notes}</CardContent>
            )}
          </Card>

          {asset.kind === "SOFTWARE_LICENCE" && (asset.licenceKey || asset.seats) && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Licence</CardHeader>
              <CardContent className="space-y-2 text-sm">
                {asset.seats && <Fact label="Seats" value={String(asset.seats)} />}
                {asset.licenceKey && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-subtle">Key</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <span className="font-mono text-sm text-text">
                        {showKey ? asset.licenceKey : "•".repeat(Math.min(asset.licenceKey.length, 29))}
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowKey((v) => !v)}
                        className="text-subtle hover:text-text"
                        aria-label={showKey ? "Hide the key" : "Show the key"}
                      >
                        {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card className="overflow-hidden p-0">
            <CardHeader className="text-sm font-medium text-text">History</CardHeader>
            <ul className="divide-y divide-line">
              {asset.movements.map((m) => (
                <li key={m.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-text">{movementLabels[m.type]}</span>
                    {/* The day it moved, as typed — held as midnight UTC. */}
                    <span className="text-xs text-subtle">{formatCalendarDay(m.occurredAt)}</span>
                    {m.acknowledgedAt && (
                      <Badge tone="green">
                        <Check className="h-3 w-3" />
                        Confirmed
                      </Badge>
                    )}
                    {m.consignment && (
                      <Link
                        href={`/logistics/${m.consignment.id}`}
                        className="font-mono text-xs text-brand hover:underline"
                      >
                        {m.consignment.consignmentNumber}
                      </Link>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <span>{m.fromUser?.name ?? m.fromCompany?.name ?? m.fromLabel ?? "Stock"}</span>
                    <ArrowRight className="h-3 w-3 text-subtle" />
                    <span>{m.toUser?.name ?? m.toContact?.name ?? m.toCompany?.name ?? m.toLabel ?? "Stock"}</span>
                    <span className="text-subtle">· {m.recordedBy.name}</span>
                  </div>
                  {m.note && <p className="mt-0.5 text-xs text-subtle">{m.note}</p>}
                </li>
              ))}
              {asset.movements.length === 0 && (
                <li className="px-4 py-8 text-center text-sm text-subtle">Nothing recorded yet.</li>
              )}
            </ul>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="flex items-center justify-between gap-2 text-sm font-medium text-text">
              <span>Cover</span>
              <Badge tone={cover.tone}>{cover.label}</Badge>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Fact label="Warranty" value={asset.warrantyEndsOn ? formatCalendarDay(asset.warrantyEndsOn) : "Not recorded"} />
              <Fact label="AMC" value={asset.amcEndsOn ? formatCalendarDay(asset.amcEndsOn) : "Not recorded"} />
              {asset.amc && (
                <p className="text-xs text-muted">
                  Under{" "}
                  <Link href={`/renewals`} className="text-brand hover:underline">
                    {asset.amc.item?.name ?? "an AMC"}
                  </Link>
                  {asset.amc.endDate && `, to ${formatCalendarDay(asset.amc.endDate)}`}
                </p>
              )}
              {cover.key === "NONE" && (
                <p className="text-xs text-subtle">
                  Nothing recorded, which isn&apos;t the same as nothing existing — worth checking the invoice.
                </p>
              )}
              {cover.key === "EXPIRED" && (
                <p className="text-xs text-warning">
                  If this breaks, we pay. Worth an AMC quote if it&apos;s still in service.
                </p>
              )}
            </CardContent>
          </Card>

          {asset.fixedAsset && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Financial record</CardHeader>
              <CardContent className="text-sm">
                <Link href="/accounting/assets" className="text-brand hover:underline">
                  {asset.fixedAsset.tag}
                </Link>
                <p className="mt-1 text-xs text-muted">
                  Depreciation is charged against this in the fixed asset register.
                </p>
              </CardContent>
            </Card>
          )}

          {canManage && asset.status !== "RETIRED" && (
            <Card>
              <CardHeader className="text-sm font-medium text-text">Record a movement</CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {MOVES.map((type) => {
                  const allowed = canMove(asset.status, type);
                  return (
                    <Button
                      key={type}
                      size="sm"
                      variant="secondary"
                      disabled={!allowed.ok || pending}
                      title={allowed.ok ? undefined : (allowed as { reason: string }).reason}
                      onClick={() => setMoving(type)}
                    >
                      {movementLabels[type]}
                    </Button>
                  );
                })}
              </CardContent>
            </Card>
          )}

          {asset.tickets.length > 0 && (
            <Card className="overflow-hidden p-0">
              <CardHeader className="text-sm font-medium text-text">Faults</CardHeader>
              <ul className="divide-y divide-line">
                {asset.tickets.map((t) => (
                  <li key={t.id} className="px-4 py-2">
                    <Link href={`/tickets/${t.id}`} className="flex items-start gap-2 text-sm hover:underline">
                      <TicketIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-subtle" />
                      <span className="min-w-0">
                        <span className="block truncate text-text">{t.title}</span>
                        <span className="block text-xs text-subtle">
                          #{t.ticketSeq} · {clock.date(t.createdAt)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>

      {moving && (
        <MoveDialog
          asset={asset}
          type={moving}
          people={people}
          companies={companies}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            router.refresh();
          }}
          setError={setError}
        />
      )}
    </div>
  );
}

function MoveDialog({
  asset,
  type,
  people,
  companies,
  onClose,
  onDone,
  setError,
}: {
  asset: Asset;
  type: AssetMovementType;
  people: { id: string; name: string }[];
  companies: { id: string; name: string }[];
  onClose: () => void;
  onDone: () => void;
  setError: (e: string | null) => void;
}) {
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  // Held with the company it was loaded for, so the list can be *derived* during render rather than
  // cleared from inside an effect — which also stops a previous company's sites flashing up while
  // the new ones are still loading.
  const [loadedSites, setLoadedSites] = useState<{
    companyId: string;
    rows: { id: string; label: string; city: string | null }[];
  } | null>(null);
  const [form, setForm] = useState({
    occurredAt: clock.today(),
    toUserId: "",
    toCompanyId: "",
    toLocationId: "",
    toLabel: "",
    note: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const locations = loadedSites?.companyId === form.toCompanyId ? loadedSites.rows : [];

  useEffect(() => {
    if (!form.toCompanyId) return;
    let cancelled = false;
    locationsFor(form.toCompanyId).then((rows) => {
      if (!cancelled) setLoadedSites({ companyId: form.toCompanyId, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [form.toCompanyId]);

  const needsPerson = type === "ASSIGNED";
  const needsPlace = type === "TRANSFERRED";
  const needsWhere = type === "SENT_FOR_REPAIR";
  const after = statusAfter(type);

  return (
    <Dialog open onClose={onClose} title={`${movementLabels[type]} — ${asset.assetTag}`}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          This will leave it <span className="text-text">{statusLabels[after].toLowerCase()}</span>.
          {type === "SCRAPPED" && " Retiring it is final — nothing can be moved afterwards without receiving it back."}
        </p>

        <div className="space-y-1.5">
          <Label htmlFor="when">When</Label>
          <Input id="when" type="date" value={form.occurredAt} onChange={set("occurredAt")} />
        </div>

        {needsPerson && (
          <div className="space-y-1.5">
            <Label htmlFor="who">To whom</Label>
            <Select id="who" value={form.toUserId} onChange={set("toUserId")}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">
              They&apos;ll be told, and it stays on their record until it comes back.
            </p>
          </div>
        )}

        {needsPlace && (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="toco">To</Label>
              <Select id="toco" value={form.toCompanyId} onChange={set("toCompanyId")}>
                <option value="">Our office</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            {locations.length > 0 && (
              <div className="space-y-1.5">
                <Label htmlFor="toloc">Site</Label>
                <Select id="toloc" value={form.toLocationId} onChange={set("toLocationId")}>
                  <option value="">—</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                      {l.city ? ` — ${l.city}` : ""}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </>
        )}

        {needsWhere && (
          <div className="space-y-1.5">
            <Label htmlFor="svc">Where to</Label>
            <Input id="svc" value={form.toLabel} onChange={set("toLabel")} placeholder="Lenovo service centre, Andheri" />
            <p className="text-xs text-subtle">
              Somewhere with no record of its own — a service centre, a courier hub.
            </p>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="note">Note</Label>
          <Textarea id="note" rows={2} value={form.note} onChange={set("note")} />
        </div>

        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending || (needsPerson && !form.toUserId)}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await moveAsset({
                  assetId: asset.id,
                  type,
                  occurredAt: form.occurredAt,
                  toUserId: form.toUserId || undefined,
                  toCompanyId: form.toCompanyId || undefined,
                  toLocationId: form.toLocationId || undefined,
                  toLabel: form.toLabel || undefined,
                  note: form.note || undefined,
                });
                if (!result.ok) {
                  setError(result.error);
                  onClose();
                  return;
                }
                onDone();
              });
            }}
          >
            {pending ? "Recording…" : movementLabels[type]}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-0.5 text-text">{value}</div>
    </div>
  );
}
