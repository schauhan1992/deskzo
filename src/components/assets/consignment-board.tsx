"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Truck } from "lucide-react";
import type { ConsignmentReason } from "@prisma/client";
import type { dispatchableAssets, listConsignments } from "@/actions/consignment";
import { createConsignment } from "@/actions/consignment";
import { locationsFor } from "@/actions/it-asset";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { TransporterCombobox, type TransporterOption } from "@/components/logistics/transporter-combobox";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  consignmentReasonLabels,
  consignmentStatusLabels,
  consignmentStatusTone,
  EWAY_BILL_THRESHOLD,
  ewayBillRequired,
  paperworkFor,
} from "@/lib/assets/lifecycle";

type Consignment = Awaited<ReturnType<typeof listConsignments>>[number];
type Dispatchable = Awaited<ReturnType<typeof dispatchableAssets>>[number];

const REASONS: ConsignmentReason[] = [
  "SALE_DELIVERY",
  "DEPLOYMENT",
  "REPAIR_OUT",
  "REPAIR_RETURN",
  "RETURN_TO_VENDOR",
  "INTERNAL_TRANSFER",
  "COLLECTION",
];

export function ConsignmentBoard({
  consignments,
  assets,
  companies,
  transporters,
  intraStateThreshold,
}: {
  consignments: Consignment[];
  assets: Dispatchable[];
  companies: { id: string; name: string }[];
  transporters: TransporterOption[];
  /**
   * The state's own intra-state floor, from settings.
   *
   * Passed in rather than assumed, because this screen is where somebody decides whether a lorry
   * can leave. It used to hardcode ₹50,000 while the e-way list read the setting, so the two
   * disagreed about the same consignment and the one with the deadline on it was the wrong one.
   */
  intraStateThreshold?: number;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New consignment
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <CardHeader className="text-sm font-medium text-text">Consignments</CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Number</th>
                <th className="px-4 py-2.5">Why</th>
                <th className="px-4 py-2.5">To</th>
                <th className="px-4 py-2.5">Items</th>
                <th className="px-4 py-2.5">Courier</th>
                <th className="px-4 py-2.5">E-way bill</th>
                <th className="px-4 py-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {consignments.map((c) => {
                const eway = ewayBillRequired(
                  {
                    declaredValue: c.declaredValue ? Number(c.declaredValue) : null,
                    interstate: c.interstate,
                    reason: c.reason,
                  },
                  { intraStateThreshold },
                );
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="px-4 py-2.5">
                      <Link href={`/logistics/${c.id}`} className="font-mono text-xs text-brand hover:underline">
                        {c.consignmentNumber}
                      </Link>
                      <span className="block text-[11px] text-subtle">{formatDate(c.createdAt)}</span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {consignmentReasonLabels[c.reason]}
                      <span className="block text-[11px] text-subtle">
                        {paperworkFor(c.reason) === "TAX_INVOICE" ? "on an invoice" : "on a challan"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {c.toCompany?.name ?? "—"}
                      {c.toLocation && <span className="block text-[11px] text-subtle">{c.toLocation.label}</span>}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{c._count.movements}</td>
                    <td className="px-4 py-2.5 text-muted">
                      {c.transporter?.name ?? c.courier ?? "—"}
                      {c.docketNumber && <span className="block text-[11px] text-subtle">{c.docketNumber}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      {c.ewayBillNumber ? (
                        <span className="font-mono text-xs text-muted">{c.ewayBillNumber}</span>
                      ) : eway.required ? (
                        <Badge tone="amber">Needed</Badge>
                      ) : (
                        <span className="text-xs text-subtle">Not needed</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={consignmentStatusTone[c.status]}>{consignmentStatusLabels[c.status]}</Badge>
                    </td>
                  </tr>
                );
              })}
              {consignments.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-subtle">
                    Nothing in transit. A consignment is a batch of assets travelling together — fifteen laptops to
                    one office, under one docket, on one e-way bill.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {creating && (
        <NewConsignmentDialog
          assets={assets}
          companies={companies}
          transporters={transporters}
          intraStateThreshold={intraStateThreshold}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function NewConsignmentDialog({
  assets,
  companies,
  transporters,
  intraStateThreshold,
  onClose,
}: {
  assets: Dispatchable[];
  companies: { id: string; name: string }[];
  transporters: TransporterOption[];
  intraStateThreshold?: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  // Held with the company it was loaded for, so the list can be *derived* during render rather than
  // cleared from inside an effect — which also stops a previous company's sites flashing up while
  // the new ones are still loading.
  const [loadedSites, setLoadedSites] = useState<{
    companyId: string;
    rows: { id: string; label: string; city: string | null }[];
  } | null>(null);
  const [form, setForm] = useState({
    reason: "SALE_DELIVERY" as ConsignmentReason,
    toCompanyId: "",
    toLocationId: "",
    toAddress: "",
    courier: "",
    transporterId: "",
    expectedOn: "",
    notes: "",
  });
  const [interstate, setInterstate] = useState(false);
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

  const shown = assets.filter(
    (a) =>
      !search ||
      `${a.assetTag} ${a.name} ${a.serialNumber ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  // Totalled as you tick, because that is what decides whether an e-way bill is needed.
  const value = assets
    .filter((a) => picked.has(a.id))
    .reduce((t, a) => t + Number(a.purchaseCost ?? 0), 0);
  const eway = ewayBillRequired({ declaredValue: value || null, interstate, reason: form.reason }, { intraStateThreshold });

  return (
    <Dialog open onClose={onClose} title="New consignment">
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="reason">Why is it moving?</Label>
          <Select id="reason" value={form.reason} onChange={set("reason")}>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {consignmentReasonLabels[r]}
              </option>
            ))}
          </Select>
          <p className="text-xs text-subtle">
            {paperworkFor(form.reason) === "TAX_INVOICE"
              ? "A sale, so it travels on a tax invoice."
              : "Nothing is being sold, so it travels on a delivery challan — no tax, and it never reaches the ledger."}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="toc">To</Label>
            {/* A search box rather than a dropdown: the company list runs to hundreds, and scrolling
                for a name you already know is the slowest way to pick it. */}
            <CompanyCombobox
              id="toc"
              companies={companies}
              value={form.toCompanyId}
              onSelect={(c) => setForm((f) => ({ ...f, toCompanyId: c?.id ?? "", toLocationId: "" }))}
            />
          </div>
          {locations.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="tol">Site</Label>
              <Select id="tol" value={form.toLocationId} onChange={set("toLocationId")}>
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
          <div className="space-y-1.5">
            <Label htmlFor="cr">Transporter</Label>
            <TransporterCombobox
              id="cr"
              transporters={transporters}
              value={form.transporterId}
              onSelect={(t) => setForm((f) => ({ ...f, transporterId: t?.id ?? "", courier: t?.name ?? "" }))}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exp">Expected</Label>
            <Input id="exp" type="date" value={form.expectedOn} onChange={set("expectedOn")} />
          </div>
        </div>

        <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
          <Checkbox checked={interstate} onChange={() => setInterstate((v) => !v)} />
          Crossing a state line
        </label>

        <div className="space-y-2">
          <Label htmlFor="pick">What&apos;s going ({picked.size} picked)</Label>
          <Input
            id="pick"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by tag, name or serial"
          />
          <div className="max-h-56 overflow-y-auto rounded-base border border-line">
            {shown.map((a) => (
              <label
                key={a.id}
                className="flex cursor-pointer items-center gap-2 border-b border-line px-3 py-2 last:border-0 hover:bg-surface-sunken"
              >
                <input
                  type="checkbox"
                  checked={picked.has(a.id)}
                  onChange={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(a.id)) next.delete(a.id);
                      else next.add(a.id);
                      return next;
                    })
                  }
                  className="h-3.5 w-3.5 accent-[var(--color-brand)]"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text">
                    <span className="font-mono text-xs text-subtle">{a.assetTag}</span> {a.name}
                  </span>
                  <span className="block text-xs text-subtle">
                    {a.serialNumber ?? "no serial"}
                    {a.custodian && ` · with ${a.custodian.name}`}
                    {a.siteCompany && ` · at ${a.siteCompany.name}`}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted">
                  {a.purchaseCost ? formatCurrency(Number(a.purchaseCost)) : "—"}
                </span>
              </label>
            ))}
            {shown.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-subtle">Nothing matches.</p>
            )}
          </div>
        </div>

        {picked.size > 0 && (
          <Card
            className={`px-3 py-2 text-xs ${eway.required ? "border-warning/40 bg-warning-bg text-warning" : "text-muted"}`}
          >
            {formatCurrency(value)} of goods.{" "}
            {eway.required
              ? `An e-way bill is needed — ${eway.reason}`
              : `Below the ₹${EWAY_BILL_THRESHOLD.toLocaleString("en-IN")} threshold, so no e-way bill.`}
          </Card>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="cnotes">Notes</Label>
          <Textarea id="cnotes" rows={2} value={form.notes} onChange={set("notes")} />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button
            disabled={pending || picked.size === 0}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await createConsignment({
                  ...form,
                  interstate,
                  assetIds: [...picked],
                  toCompanyId: form.toCompanyId || undefined,
                  toLocationId: form.toLocationId || undefined,
                });
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                onClose();
                router.push(`/logistics/${result.data.id}`);
              });
            }}
          >
            <Truck className="mr-1.5 h-3.5 w-3.5" />
            {pending ? "Creating…" : "Create"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
