"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, RotateCcw, Truck } from "lucide-react";
import { saveTransporter, setTransporterActive, type TransporterRow } from "@/actions/transporter";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";

const MODE_LABEL: Record<string, string> = { ROAD: "Road", RAIL: "Rail", AIR: "Air", SHIP: "Ship" };

type Draft = {
  id: string | null;
  name: string;
  gstin: string;
  contactName: string;
  phone: string;
  email: string;
  defaultMode: "ROAD" | "RAIL" | "AIR" | "SHIP";
  notes: string;
};

const BLANK: Draft = {
  id: null,
  name: "",
  gstin: "",
  contactName: "",
  phone: "",
  email: "",
  defaultMode: "ROAD",
  notes: "",
};

export function TransporterManager({
  transporters,
  showRetired,
}: {
  transporters: TransporterRow[];
  showRetired: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    startTransition(async () => {
      const result = await saveTransporter({
        id: draft.id,
        name: draft.name,
        gstin: draft.gstin,
        contactName: draft.contactName,
        phone: draft.phone,
        email: draft.email,
        defaultMode: draft.defaultMode,
        notes: draft.notes,
      });
      setBusy(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(null);
      router.refresh();
    });
  }

  function toggle(row: TransporterRow) {
    setBusy(true);
    startTransition(async () => {
      await setTransporterActive({ id: row.id, active: !row.active });
      setBusy(false);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <a
          href={showRetired ? "/logistics/transporters" : "/logistics/transporters?retired=1"}
          className="text-sm text-muted hover:text-text"
        >
          {showRetired ? "Hide retired" : "Show retired"}
        </a>
        <Button onClick={() => setDraft(BLANK)}>
          <Plus className="h-4 w-4" />
          New transporter
        </Button>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">GSTIN / TRANSIN</th>
              <th className="px-4 py-2.5 font-medium">Contact</th>
              <th className="px-4 py-2.5 font-medium">Mode</th>
              <th className="px-4 py-2.5 text-right font-medium">Used on</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {transporters.map((t) => (
              <tr key={t.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                <td className="px-4 py-2.5">
                  <span className="font-medium text-text">{t.name}</span>
                  {!t.active && <Badge className="ml-2">Retired</Badge>}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-xs">
                  {t.gstin ?? (
                    <span className="font-sans text-subtle" title="Without one, a bill can't be raised before the vehicle is known.">
                      Not recorded
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">
                  {t.contactName || t.phone || t.email ? (
                    <span>
                      {t.contactName}
                      {t.contactName && (t.phone || t.email) ? " · " : ""}
                      {t.phone || t.email}
                    </span>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted">{MODE_LABEL[t.defaultMode] ?? t.defaultMode}</td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-muted">
                  {t.consignments} consignment{t.consignments === 1 ? "" : "s"}
                  {t.ewayBills > 0 && `, ${t.ewayBills} bill${t.ewayBills === 1 ? "" : "s"}`}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        id: t.id,
                        name: t.name,
                        gstin: t.gstin ?? "",
                        contactName: t.contactName ?? "",
                        phone: t.phone ?? "",
                        email: t.email ?? "",
                        defaultMode: t.defaultMode,
                        notes: t.notes ?? "",
                      })
                    }
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Edit
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => toggle(t)}>
                    {t.active ? (
                      "Retire"
                    ) : (
                      <>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Restore
                      </>
                    )}
                  </Button>
                </td>
              </tr>
            ))}
            {transporters.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
                  <Truck className="mx-auto mb-2 h-5 w-5 text-subtle" />
                  No transporters yet. Add the couriers you actually use, with their GSTIN where you have it.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <Dialog
        open={draft !== null}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit transporter" : "New transporter"}
      >
        {draft && (
          <div className="space-y-3">
            {error && (
              <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
            )}
            <div className="space-y-1">
              <Label htmlFor="t-name">Name</Label>
              <Input id="t-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-gstin">GSTIN or TRANSIN</Label>
              <Input
                id="t-gstin"
                value={draft.gstin}
                onChange={(e) => setDraft({ ...draft, gstin: e.target.value.toUpperCase() })}
                placeholder="15 characters"
              />
              <p className="text-xs text-muted">
                {/*
                  Worth saying once, here, rather than leaving it to be discovered at despatch: this
                  is the field that decides whether Part A can go without a vehicle.
                */}
                A transporter registered for GST has a GSTIN; one that isn&rsquo;t enrols for a TRANSIN. Either lets a
                bill be raised before the vehicle is known — without one, the lorry number is needed up front.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="t-contact">Contact</Label>
                <Input
                  id="t-contact"
                  value={draft.contactName}
                  onChange={(e) => setDraft({ ...draft, contactName: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="t-phone">Phone</Label>
                <Input id="t-phone" value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="t-email">Email</Label>
                <Input
                  id="t-email"
                  type="email"
                  value={draft.email}
                  onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="t-mode">Usual mode</Label>
                <Select
                  id="t-mode"
                  value={draft.defaultMode}
                  onChange={(e) => setDraft({ ...draft, defaultMode: e.target.value as Draft["defaultMode"] })}
                >
                  <option value="ROAD">Road</option>
                  <option value="RAIL">Rail</option>
                  <option value="AIR">Air</option>
                  <option value="SHIP">Ship</option>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="t-notes">Notes</Label>
              <Textarea
                id="t-notes"
                rows={2}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="Rates, pickup cut-off, who to ring when a box goes missing…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button disabled={busy || !draft.name.trim()} onClick={save}>
                Save
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
