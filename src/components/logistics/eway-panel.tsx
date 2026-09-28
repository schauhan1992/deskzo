"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileCheck2, Link2, Search, Truck, XCircle } from "lucide-react";
import {
  associateEwayBill,
  lookupEwayBill,
  cancelEwayBill,
  generateEwayBill,
  saveEwayDetails,
  updateEwayVehicle,
  type EwayDocumentView,
} from "@/actions/eway";
import { CANCEL_REASONS, VEHICLE_UPDATE_REASONS } from "@/lib/eway/provider";
import { THRESHOLD, lastValidDay } from "@/lib/eway/rules";

/** A Date as the `yyyy-mm-dd` a date input wants, in the reader's own timezone. */
function localDay(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { TransporterCombobox } from "@/components/logistics/transporter-combobox";
import { formatCurrency, formatDateTime } from "@/lib/utils";

/**
 * The e-way bill for one document.
 *
 * Laid out as a state, then the one thing to do about it. The state is the point: this is the only
 * screen in the app where "nothing has been done" is a legal problem rather than a backlog, and a
 * panel that reads the same whether or not a lorry has left without its paperwork would be worse
 * than no panel at all.
 */

const TONE: Record<EwayDocumentView["standing"]["tone"], "green" | "amber" | "red" | "default"> = {
  ok: "green",
  warn: "amber",
  danger: "red",
  muted: "default",
};

export function EwayPanel({
  view,
  transporters,
  onChanged,
}: {
  view: EwayDocumentView;
  transporters: { id: string; name: string; gstin: string | null }[];
  /**
   * Called after anything succeeds, for a caller holding its own copy of the view.
   *
   * A page re-renders on `router.refresh()` and needs nothing; a side pane keeps the view in its
   * own state and would otherwise sit there showing what was true before the button was pressed.
   */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [open, setOpen] = useState<"none" | "details" | "vehicle" | "cancel" | "associate">("none");

  const bill = view.bill;
  const [draft, setDraft] = useState({
    declaredValue: String(bill?.declaredValue ?? view.total),
    interstate: bill?.interstate ?? view.interstate,
    distanceKm: bill?.distanceKm ? String(bill.distanceKm) : "",
    transporterId: bill?.transporterId ?? "",
    transportMode: bill?.transportMode ?? ("ROAD" as const),
    vehicleType: bill?.vehicleType ?? ("REGULAR" as const),
    vehicleNumber: bill?.vehicleNumber ?? "",
    transportDocNumber: bill?.transportDocNumber ?? "",
  });
  const [vehicle, setVehicle] = useState({ number: bill?.vehicleNumber ?? "", reason: "4", note: "" });
  const [cancel, setCancel] = useState({ reason: "2", remark: "" });
  const [associate, setAssociate] = useState({ number: "", date: "", until: "" });
  const [fetched, setFetched] = useState<{ documentNumber: string | null; vehicleNumber: string | null } | null>(null);

  /**
   * Ask the portal what it holds against that number, and fill the dates in from the answer.
   *
   * The dates are the two fields worth getting from the source: an expiry typed a day long reads
   * valid on this screen and is refused at a checkpoint, and nobody would find that until it
   * happened.
   */
  function lookup() {
    setBusy(true);
    setNotice(null);
    setFetched(null);
    startTransition(async () => {
      // With the document, so the portal is asked under the GSTIN this document was issued from.
      const result = await lookupEwayBill(associate.number, view.documentId);
      setBusy(false);
      if (!result.ok) {
        setNotice({ text: result.error, bad: true });
        return;
      }
      setAssociate({
        number: result.data.ewayBillNumber,
        date: localDay(new Date(result.data.ewayBillDate)),
        // The last day it covers, not the midnight it expires at — see `lastValidDay`.
        until: lastValidDay(new Date(result.data.validUntil)),
      });
      setFetched({ documentNumber: result.data.documentNumber, vehicleNumber: result.data.vehicleNumber });
      if (result.data.status === "CANCELLED") {
        setNotice({ text: "The portal says that bill has been cancelled. Recording it will not cover this movement.", bad: true });
      }
    });
  }

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, success: string) => {
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      const result = (await fn()) as { ok: boolean; error?: string };
      setBusy(false);
      if (!result.ok) {
        setNotice({ text: result.error ?? "That didn't work.", bad: true });
        return;
      }
      setOpen("none");
      setNotice({ text: success });
      router.refresh();
      onChanged?.();
    });
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          <FileCheck2 className="h-4 w-4 text-muted" />
          E-way bill
        </div>
        <Badge tone={TONE[view.standing.tone]}>
          {view.standing.tone === "ok" && <CheckCircle2 className="h-3 w-3" />}
          {view.standing.tone === "danger" && <AlertTriangle className="h-3 w-3" />}
          {view.standing.headline}
        </Badge>
      </CardHeader>

      <CardContent className="space-y-3">
        <p className={view.standing.tone === "danger" ? "text-sm font-medium text-danger" : "text-sm text-muted"}>
          {view.standing.detail}
        </p>

        {notice && (
          <p
            className={
              notice.bad
                ? "rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger"
                : "rounded-base border border-success/40 bg-success-bg px-3 py-2 text-sm text-success"
            }
          >
            {notice.text}
          </p>
        )}

        {bill?.error && !bill.ewayBillNumber && (
          <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
            {/* The portal's own words, verbatim — a paraphrased rejection is not a clue. */}
            The portal refused it: {bill.error}
          </p>
        )}

        {bill?.ewayBillNumber && (
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-muted">Number</dt>
              <dd className="font-mono text-text">{bill.ewayBillNumber}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Raised</dt>
              <dd className="text-text">{bill.ewayBillDate ? formatDateTime(bill.ewayBillDate) : "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted">Valid until</dt>
              <dd className="text-text">{bill.validUntil ? formatDateTime(bill.validUntil) : "—"}</dd>
            </div>
            {bill.vehicleNumber && (
              <div className="flex gap-2">
                <dt className="text-muted">Vehicle</dt>
                <dd className="font-mono text-text">{bill.vehicleNumber}</dd>
              </div>
            )}
            {bill.transporterName && (
              <div className="flex gap-2">
                <dt className="text-muted">Transporter</dt>
                <dd className="text-text">{bill.transporterName}</dd>
              </div>
            )}
            {bill.cancelReason && (
              <div className="flex gap-2">
                <dt className="text-muted">Cancelled</dt>
                <dd className="text-text">{bill.cancelReason}</dd>
              </div>
            )}
          </dl>
        )}

        {bill?.associated && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-xs text-muted">
            {/* Said plainly, because the missing buttons would otherwise look like a fault. */}
            This bill was raised on the portal and recorded here. It can&rsquo;t be cancelled or have its vehicle changed
            from this app — do both on the portal.
          </p>
        )}

        {!view.configured && view.required && (
          <p className="flex items-start gap-2 rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {/* The reason names the GSTIN and the screen to fix it on: each registration signs in with its own
                e-invoicing credentials, so "not set up" alone no longer says which ones are missing. */}
            <span>
              {view.configError ? `${view.configError.replace(/\.$/, "")}.` : "The portal isn’t set up — Settings → e-Invoicing."} The
              e-way portal signs in with the same credentials as e-invoicing. You can still record a bill raised on the portal
              by hand.
            </span>
          </p>
        )}

        {view.missingOnDocument.length > 0 && view.required && !bill?.ewayBillNumber && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-sm text-muted">
            The portal will refuse this until{" "}
            <Link href={`/documents/${view.documentId}/edit`} className="text-brand hover:underline">
              {view.docNumber}
            </Link>{" "}
            has <span className="font-medium text-text">{view.missingOnDocument.join(" and ")}</span>.
          </p>
        )}

        {view.missing.length > 0 && view.required && !bill?.ewayBillNumber && (
          <p className="rounded-base bg-surface-sunken px-3 py-2 text-sm text-muted">
            Under <span className="font-medium text-text">Transport details</span>, fill in{" "}
            <span className="font-medium text-text">{view.missing.join(" and ")}</span>.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {view.required && view.standing.headline !== "Valid" && view.configured && (
            <Button
              disabled={busy || view.missing.length > 0 || view.missingOnDocument.length > 0}
              onClick={() => run(() => generateEwayBill(view.documentId), "E-way bill raised.")}
            >
              <FileCheck2 className="h-4 w-4" />
              Raise the e-way bill
            </Button>
          )}

          {view.standing.headline === "Valid" && !bill?.associated && (
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(open === "vehicle" ? "none" : "vehicle")}>
              <Truck className="h-4 w-4" />
              {bill?.vehicleNumber ? "Change the vehicle" : "Add the vehicle"}
            </Button>
          )}

          {view.canCancel && (
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(open === "cancel" ? "none" : "cancel")}>
              Cancel the bill
            </Button>
          )}

          {!bill?.ewayBillNumber && (
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(open === "associate" ? "none" : "associate")}>
              <Link2 className="h-4 w-4" />
              Record one from the portal
            </Button>
          )}

          <Button variant="ghost" disabled={busy} onClick={() => setOpen(open === "details" ? "none" : "details")}>
            {open === "details" ? "Close" : "Transport details"}
          </Button>
        </div>

        {open === "associate" && (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-3">
            <p className="text-xs text-muted">
              For a bill raised on the e-way bill portal directly. Type the number and fetch the rest — it stays the
              portal&rsquo;s to cancel or amend, but the list stops showing this document as outstanding.
            </p>
            <div className="flex gap-2">
              {/*
                Named here rather than with a `<Label htmlFor>` like the two date fields below,
                because this row is a field and its button — there is no caption to pair with, and
                the placeholder stops being a name the moment somebody types into it.
              */}
              <Input
                aria-label="E-way bill number"
                placeholder="12-digit number"
                inputMode="numeric"
                value={associate.number}
                onChange={(e) => {
                  setAssociate({ ...associate, number: e.target.value });
                  setFetched(null);
                }}
              />
              <Button variant="secondary" disabled={busy || associate.number.replace(/\s/g, "").length !== 12} onClick={lookup}>
                <Search className="h-4 w-4" />
                Fetch
              </Button>
            </div>

            {fetched && (
              <p className="rounded-base bg-surface px-3 py-2 text-xs text-muted">
                {/*
                  Shown before it is committed, because the portal will return a bill raised against
                  a different document just as readily as the right one.
                */}
                The portal has this against{" "}
                <span className="font-medium text-text">{fetched.documentNumber ?? "a document it did not name"}</span>
                {fetched.vehicleNumber && (
                  <>
                    , vehicle <span className="font-mono text-text">{fetched.vehicleNumber}</span>
                  </>
                )}
                . This document is <span className="font-medium text-text">{view.docNumber}</span>.
              </p>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="assoc-from">Raised on</Label>
                <Input
                  id="assoc-from"
                  type="date"
                  value={associate.date}
                  onChange={(e) => setAssociate({ ...associate, date: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="assoc-to">Last day it covers</Label>
                <Input
                  id="assoc-to"
                  type="date"
                  value={associate.until}
                  onChange={(e) => setAssociate({ ...associate, until: e.target.value })}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen("none")}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !associate.number.trim() || !associate.date || !associate.until}
                onClick={() =>
                  run(
                    () =>
                      associateEwayBill({
                        documentId: view.documentId,
                        ewayBillNumber: associate.number,
                        ewayBillDate: associate.date,
                        validUntil: associate.until,
                      }),
                    "Recorded.",
                  )
                }
              >
                Record it
              </Button>
            </div>
          </div>
        )}

        {open === "vehicle" && (
          <div className="space-y-2 rounded-base border border-line bg-surface-sunken p-3">
            {/*
              Part B is the ordinary case, not a correction: the bill goes out in the morning against
              a transporter id and the lorry is assigned at four.
            */}
            <p className="text-xs text-muted">
              Updating Part B on the portal. The number is only saved here once the portal accepts it.
            </p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Input
                aria-label="Vehicle number"
                placeholder="MH12AB1234"
                value={vehicle.number}
                onChange={(e) => setVehicle({ ...vehicle, number: e.target.value })}
              />
              <Select
                aria-label="Reason for the vehicle change"
                value={vehicle.reason}
                onChange={(e) => setVehicle({ ...vehicle, reason: e.target.value })}
              >
                {VEHICLE_UPDATE_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Note"
                placeholder="Note (optional)"
                value={vehicle.note}
                onChange={(e) => setVehicle({ ...vehicle, note: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen("none")}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !vehicle.number.trim()}
                onClick={() =>
                  run(
                    () =>
                      updateEwayVehicle({
                        documentId: view.documentId,
                        vehicleNumber: vehicle.number,
                        reasonCode: vehicle.reason,
                        reasonNote: vehicle.note,
                      }),
                    "Vehicle updated on the portal.",
                  )
                }
              >
                Update Part B
              </Button>
            </div>
          </div>
        )}

        {open === "cancel" && (
          <div className="space-y-2 rounded-base border border-danger/40 bg-danger-bg p-3">
            <p className="text-xs text-danger">
              A bill can only be cancelled within 24 hours of being raised, and not once it has been verified in
              transit.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                aria-label="Reason for cancelling"
                value={cancel.reason}
                onChange={(e) => setCancel({ ...cancel, reason: e.target.value })}
              >
                {CANCEL_REASONS.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.label}
                  </option>
                ))}
              </Select>
              <Input
                aria-label="Cancellation remark"
                placeholder="In your own words"
                value={cancel.remark}
                onChange={(e) => setCancel({ ...cancel, remark: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen("none")}>
                Keep it
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy || !cancel.remark.trim()}
                onClick={() =>
                  run(
                    () => cancelEwayBill({ documentId: view.documentId, reasonCode: cancel.reason, remark: cancel.remark }),
                    "Cancelled on the portal.",
                  )
                }
              >
                Cancel the bill
              </Button>
            </div>
          </div>
        )}

        {open === "details" && (
          <div className="space-y-3 rounded-base border border-line bg-surface-sunken p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="eway-value">Value of the goods</Label>
                <Input
                  id="eway-value"
                  inputMode="decimal"
                  value={draft.declaredValue}
                  onChange={(e) => setDraft({ ...draft, declaredValue: e.target.value })}
                />
                <p className="text-xs text-muted">
                  {/* The rule people get wrong: it is the consignment, not the sale. */}
                  What the goods are worth to move, sale or not — which on a delivery challan is not what the
                  document totals, because a challan charges nothing. A bill is needed above ₹
                  {THRESHOLD.toLocaleString("en-IN")}; this movement comes to {formatCurrency(view.total)}.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="eway-distance">Distance</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="eway-distance"
                    inputMode="numeric"
                    value={draft.distanceKm}
                    onChange={(e) => setDraft({ ...draft, distanceKm: e.target.value })}
                  />
                  <span className="text-sm text-muted">km</span>
                </div>
                <p className="text-xs text-muted">
                  Decides how long the bill lasts — a day per 200 km, or per 20 km for over-dimensional cargo.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="eway-transporter">Transporter</Label>
                <TransporterCombobox
                  id="eway-transporter"
                  transporters={transporters}
                  value={draft.transporterId}
                  onSelect={(t) => setDraft({ ...draft, transporterId: t?.id ?? "" })}
                />
                <p className="text-xs text-muted">
                  Their GSTIN is what lets a bill be raised before the lorry is known.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="eway-lr">LR / consignment note</Label>
                <Input
                  id="eway-lr"
                  value={draft.transportDocNumber}
                  onChange={(e) => setDraft({ ...draft, transportDocNumber: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="eway-mode">Mode</Label>
                <Select
                  id="eway-mode"
                  value={draft.transportMode}
                  onChange={(e) => setDraft({ ...draft, transportMode: e.target.value as typeof draft.transportMode })}
                >
                  <option value="ROAD">Road</option>
                  <option value="RAIL">Rail</option>
                  <option value="AIR">Air</option>
                  <option value="SHIP">Ship</option>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="eway-vehicle-type">Vehicle</Label>
                <Select
                  id="eway-vehicle-type"
                  value={draft.vehicleType}
                  onChange={(e) => setDraft({ ...draft, vehicleType: e.target.value as typeof draft.vehicleType })}
                >
                  <option value="REGULAR">Regular</option>
                  <option value="OVER_DIMENSIONAL_CARGO">Over-dimensional cargo</option>
                </Select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="eway-vehicle">Vehicle number</Label>
                <Input
                  id="eway-vehicle"
                  value={draft.vehicleNumber}
                  onChange={(e) => setDraft({ ...draft, vehicleNumber: e.target.value })}
                />
              </div>
            </div>

            <label className="flex items-start gap-2.5">
              <input
                type="checkbox"
                checked={draft.interstate}
                onChange={(e) => setDraft({ ...draft, interstate: e.target.checked })}
                className="mt-0.5 h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-text">Crosses a state line</span>
                <span className="block text-sm text-muted">
                  The central ₹{THRESHOLD.toLocaleString("en-IN")} threshold always applies to inter-state movement;
                  some states set a higher floor within their own borders.
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen("none")}>
                Close
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(
                    () =>
                      saveEwayDetails({
                        documentId: view.documentId,
                        declaredValue: Number(draft.declaredValue),
                        interstate: draft.interstate,
                        distanceKm: Number(draft.distanceKm),
                        transporterId: draft.transporterId || null,
                        transportMode: draft.transportMode,
                        vehicleType: draft.vehicleType,
                        vehicleNumber: draft.vehicleNumber || null,
                        transportDocNumber: draft.transportDocNumber || null,
                      }),
                    "Saved.",
                  )
                }
              >
                Save
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
