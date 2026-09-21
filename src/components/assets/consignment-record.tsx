"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileText, PackageCheck, Truck, X } from "lucide-react";
import type { getConsignment } from "@/actions/consignment";
import { cancelConsignment, deliverConsignment, dispatchConsignment, raiseDeliveryChallan } from "@/actions/consignment";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/bulk-select";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatCurrency, formatDate } from "@/lib/utils";
import { consignmentReasonLabels, consignmentStatusLabels, consignmentStatusTone } from "@/lib/assets/lifecycle";

type Consignment = NonNullable<Awaited<ReturnType<typeof getConsignment>>>;

export function ConsignmentRecord({ consignment }: { consignment: Consignment }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  }

  const isDraft = consignment.status === "DRAFT";
  const inTransit = consignment.status === "IN_TRANSIT" || consignment.status === "DISPATCHED";

  return (
    <div className="space-y-4">
      <div>
        <Link href="/logistics" className="text-sm text-muted hover:text-text">
          ← Consignments
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="font-mono text-xl font-semibold text-text">{consignment.consignmentNumber}</h1>
          <Badge tone={consignmentStatusTone[consignment.status]}>{consignmentStatusLabels[consignment.status]}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          {consignmentReasonLabels[consignment.reason]}
          {consignment.toCompany && ` · to ${consignment.toCompany.name}`}
          {consignment.toLocation && ` (${consignment.toLocation.label})`}
        </p>
      </div>

      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      {/*
        The thing that stops a van at a checkpoint, said before it leaves — but only while there is
        nowhere better to say it. Once the challan exists the e-way bill panel below is the answer,
        and a second banner working off a different column is how one screen ends up disagreeing
        with itself.
      */}
      {consignment.eway.required && !consignment.ewayBillNumber && !consignment.document && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            This needs an e-way bill before it moves.
          </p>
          <p className="mt-1">{consignment.eway.reason}</p>
        </Card>
      )}

      {/* Which paperwork travels — and why it isn't an invoice. */}
      {consignment.paperwork === "DELIVERY_CHALLAN" && !consignment.document && (
        <Card className="px-4 py-3 text-sm text-muted">
          <p>
            Nothing is being sold here, so this travels on a{" "}
            <span className="text-text">delivery challan</span>, not an invoice. A challan carries no tax and never
            reaches the ledger — invoicing it would book revenue that doesn&apos;t exist.
          </p>
          {consignment.toCompany && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const result = await raiseDeliveryChallan(consignment.id);
                  if (result.ok) setMessage(`Challan ${result.data.docNumber} raised.`);
                  return result;
                })
              }
            >
              <FileText className="mr-1.5 h-3.5 w-3.5" />
              Raise the challan
            </Button>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="overflow-hidden p-0 lg:col-span-2">
          <CardHeader className="text-sm font-medium text-text">
            What&apos;s in it — {consignment.movements.length} item(s)
          </CardHeader>
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Tag</th>
                <th className="px-4 py-2.5">Asset</th>
                <th className="px-4 py-2.5">Serial</th>
                <th className="px-4 py-2.5 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {consignment.movements.map((m) => (
                <tr key={m.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <Link href={`/assets/${m.asset.id}`} className="font-mono text-xs text-brand hover:underline">
                      {m.asset.assetTag}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-text">{m.asset.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-muted">{m.asset.serialNumber ?? "—"}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">
                    {m.asset.purchaseCost ? formatCurrency(Number(m.asset.purchaseCost)) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="text-sm font-medium text-text">Movement</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Fact label="From" value={consignment.fromLabel ?? "Our office"} />
              <Fact
                label="To"
                value={consignment.toCompany?.name ?? consignment.toAddress ?? "—"}
              />
              {consignment.toContact && <Fact label="Contact" value={consignment.toContact.name} />}
              <Fact label="Courier" value={consignment.courier ?? "—"} />
              <Fact label="Docket" value={consignment.docketNumber ?? "—"} />
              <Fact label="LR number" value={consignment.lrNumber ?? "—"} />
              <Fact label="Vehicle" value={consignment.vehicleNumber ?? "—"} />
              <Fact label="Dispatched" value={consignment.dispatchedOn ? formatDate(consignment.dispatchedOn) : "—"} />
              <Fact label="Expected" value={consignment.expectedOn ? formatDate(consignment.expectedOn) : "—"} />
              <Fact label="Delivered" value={consignment.deliveredOn ? formatDate(consignment.deliveredOn) : "—"} />
              {consignment.receivedBy && <Fact label="Received by" value={consignment.receivedBy} />}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="text-sm font-medium text-text">Paperwork</CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Fact
                label="Value of goods"
                value={consignment.declaredValue ? formatCurrency(Number(consignment.declaredValue)) : "—"}
              />
              <Fact label="Movement" value={consignment.interstate ? "Between states" : "Within the state"} />
              {!consignment.document && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-subtle">E-way bill</div>
                  <div className="mt-0.5 text-text">
                    {consignment.ewayBillNumber ?? (consignment.eway.required ? "Required, not entered" : "Not required")}
                  </div>
                  <p className="mt-0.5 text-xs text-subtle">{consignment.eway.reason}</p>
                </div>
              )}
              {consignment.document && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-subtle">Document</div>
                  <Link href={`/documents/${consignment.document.id}`} className="text-brand hover:underline">
                    {consignment.document.docNumber}
                  </Link>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-wrap gap-2">
              {isDraft && (
                <Button disabled={pending} onClick={() => setDispatching(true)}>
                  <Truck className="mr-1.5 h-3.5 w-3.5" />
                  Dispatch
                </Button>
              )}
              {inTransit && (
                <Button disabled={pending} onClick={() => setDelivering(true)}>
                  <PackageCheck className="mr-1.5 h-3.5 w-3.5" />
                  Mark delivered
                </Button>
              )}
              {consignment.status !== "DELIVERED" && consignment.status !== "CANCELLED" && (
                <Button variant="secondary" disabled={pending} onClick={() => setCancelling(true)}>
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Cancel
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {dispatching && (
        <DispatchDialog
          consignment={consignment}
          onClose={() => setDispatching(false)}
          pending={pending}
          run={run}
        />
      )}
      {delivering && (
        <DeliverDialog consignment={consignment} onClose={() => setDelivering(false)} pending={pending} run={run} />
      )}
      {cancelling && (
        <CancelDialog id={consignment.id} onClose={() => setCancelling(false)} pending={pending} run={run} />
      )}
    </div>
  );
}

function DispatchDialog({
  consignment,
  onClose,
  pending,
  run,
}: {
  consignment: Consignment;
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [form, setForm] = useState({
    dispatchedOn: new Date().toISOString().slice(0, 10),
    courier: consignment.courier ?? "",
    docketNumber: consignment.docketNumber ?? "",
    lrNumber: consignment.lrNumber ?? "",
    vehicleNumber: consignment.vehicleNumber ?? "",
    ewayBillNumber: consignment.ewayBillNumber ?? "",
    ewayBillValidUntil: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog open onClose={onClose} title={`Dispatch ${consignment.consignmentNumber}`}>
      <div className="space-y-3">
        {consignment.eway.required && (
          <Card className="border-warning/40 bg-warning-bg px-3 py-2 text-xs text-warning">
            An e-way bill is required. {consignment.eway.reason} Without one the goods can be detained in transit, and
            the driver can&apos;t fix it at the checkpoint.
          </Card>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="don">Dispatched on</Label>
            <Input id="don" type="date" value={form.dispatchedOn} onChange={set("dispatchedOn")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cour">Courier</Label>
            <Input id="cour" value={form.courier} onChange={set("courier")} placeholder="Blue Dart" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dock">Docket number</Label>
            <Input id="dock" value={form.docketNumber} onChange={set("docketNumber")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lr">LR number</Label>
            <Input id="lr" value={form.lrNumber} onChange={set("lrNumber")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="veh">Vehicle</Label>
            <Input id="veh" value={form.vehicleNumber} onChange={set("vehicleNumber")} className="uppercase" placeholder="MH01AB1234" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="eway">E-way bill number</Label>
            <Input id="eway" value={form.ewayBillNumber} onChange={set("ewayBillNumber")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ewayto">Valid until</Label>
            <Input id="ewayto" type="date" value={form.ewayBillValidUntil} onChange={set("ewayBillValidUntil")} />
          </div>
        </div>
        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending}
            onClick={() => run(() => dispatchConsignment({ id: consignment.id, ...form }), onClose)}
          >
            {pending ? "Dispatching…" : "Dispatch"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeliverDialog({
  consignment,
  onClose,
  pending,
  run,
}: {
  consignment: Consignment;
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [deliveredOn, setDeliveredOn] = useState(new Date().toISOString().slice(0, 10));
  const [receivedBy, setReceivedBy] = useState("");
  const [installed, setInstalled] = useState(false);

  return (
    <Dialog open onClose={onClose} title={`${consignment.consignmentNumber} arrived`}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Every asset in this consignment lands where it was going
          {consignment.reason === "REPAIR_RETURN" && " — back into stock, since it was away for repair"}.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="delon">Delivered on</Label>
            <Input id="delon" type="date" value={deliveredOn} onChange={(e) => setDeliveredOn(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recby">Received by</Label>
            <Input id="recby" value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} placeholder="Who signed for it" />
          </div>
        </div>
        {consignment.reason !== "REPAIR_RETURN" && (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-text">
            <Checkbox checked={installed} onChange={() => setInstalled((v) => !v)} />
            Installed and working, not just dropped off
          </label>
        )}
        <div className="flex gap-2 pt-1">
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => deliverConsignment({ id: consignment.id, deliveredOn, receivedBy, installed }),
                onClose,
              )
            }
          >
            {pending ? "Recording…" : "Delivered"}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function CancelDialog({
  id,
  onClose,
  pending,
  run,
}: {
  id: string;
  onClose: () => void;
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onClose={onClose} title="Cancel this consignment">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          The assets go back to stock. The movement rows stay — the history is that they were put on a consignment
          which was then cancelled, not that nothing happened.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="creason">Why</Label>
          <Textarea id="creason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="danger" disabled={pending || !reason.trim()} onClick={() => run(() => cancelConsignment(id, reason), onClose)}>
            Cancel it
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-subtle">{label}</span>
      <span className="text-right text-text">{value}</span>
    </div>
  );
}
