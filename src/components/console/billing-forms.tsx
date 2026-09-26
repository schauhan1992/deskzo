"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { consoleAddPrice, consoleSaveBillingSettings, consoleSaveGatewayKeys, consoleSetTrialEnd } from "@/actions/platform/console";
import type { SecretKey } from "@/lib/platform/settings";

/** The console's billing forms: the gateways' keys, billing settings, a plan's prices, a trial's end. */

function useRun() {
  const router = useRouter();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (work: () => Promise<{ ok: true; data: unknown } | { ok: false; error: string }>, done: string) => {
    setMessage(null);
    startTransition(async () => {
      const r = await work();
      setMessage(r.ok ? { ok: true, text: done } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  };
  const note = message && <span className={message.ok ? "text-xs text-success" : "text-xs text-danger"}>{message.text}</span>;
  return { run, pending, note };
}

const KEYS: { key: SecretKey; label: string; hint: string }[] = [
  { key: "stripe.secretKey", label: "Stripe secret key", hint: "sk_live_… or sk_test_…" },
  { key: "stripe.webhookSecret", label: "Stripe webhook signing secret", hint: "whsec_…" },
  { key: "razorpay.keyId", label: "Razorpay key id", hint: "rzp_live_… or rzp_test_…" },
  { key: "razorpay.keySecret", label: "Razorpay key secret", hint: "" },
  { key: "razorpay.webhookSecret", label: "Razorpay webhook secret", hint: "" },
];

export function GatewayKeysForm({ set, editable }: { set: Record<SecretKey, boolean>; editable: boolean }) {
  const [values, setValues] = useState<Partial<Record<SecretKey, string>>>({});
  const [clear, setClear] = useState<SecretKey[]>([]);
  const { run, pending, note } = useRun();
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => consoleSaveGatewayKeys({ values, clear }), "Saved. Keys are sealed and never shown again.");
        setValues({});
        setClear([]);
      }}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {KEYS.map((k) => (
          <div key={k.key}>
            <Label htmlFor={`key-${k.key}`}>
              {k.label} <span className={set[k.key] ? "text-success" : "text-muted"}>{set[k.key] ? "— set" : "— not set"}</span>
            </Label>
            {/* Typed straight in and sealed; never filled back in, not even for whoever saved it. */}
            <Input
              id={`key-${k.key}`}
              type="password"
              autoComplete="off"
              disabled={!editable}
              placeholder={set[k.key] ? "Replace it" : k.hint}
              value={values[k.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
            />
            {set[k.key] && editable && (
              <label className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
                <input type="checkbox" checked={clear.includes(k.key)} onChange={(e) => setClear((c) => (e.target.checked ? [...c, k.key] : c.filter((x) => x !== k.key)))} /> Remove it
              </label>
            )}
          </div>
        ))}
      </div>
      {editable ? (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save keys"}
          </Button>
          {note}
        </div>
      ) : (
        <p className="text-xs text-muted">Only an owner changes the gateways&apos; keys.</p>
      )}
    </form>
  );
}

export function BillingSettingsForm({ signupOpen, trialDays, autoDeprovision, editable }: { signupOpen: boolean; trialDays: number; autoDeprovision: boolean; editable: boolean }) {
  const [open, setOpen] = useState(signupOpen);
  const [days, setDays] = useState(String(trialDays));
  const [close, setClose] = useState(autoDeprovision);
  const { run, pending, note } = useRun();
  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => consoleSaveBillingSettings({ signupOpen: open, trialDays: Number(days), autoDeprovision: close }), "Saved.");
      }}
    >
      <label className="flex items-center gap-2 text-text">
        <input type="checkbox" checked={open} disabled={!editable} onChange={(e) => setOpen(e.target.checked)} /> Anybody may sign up, without an invitation
      </label>
      <div className="flex items-center gap-2">
        <Label htmlFor="trial-days" className="mb-0">
          A new workspace&apos;s free trial, in days
        </Label>
        <Input id="trial-days" className="h-8 w-20" type="number" min={1} max={90} disabled={!editable} value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <label className="flex items-center gap-2 text-text">
        <input type="checkbox" checked={close} disabled={!editable} onChange={(e) => setClose(e.target.checked)} /> Close a workspace ninety days after its subscription ended and it was held (a final backup
        first)
      </label>
      {editable && (
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {note}
        </div>
      )}
    </form>
  );
}

export function AddPriceForm({ planKey }: { planKey: string }) {
  const [gateway, setGateway] = useState<"STRIPE" | "RAZORPAY">("RAZORPAY");
  const [currency, setCurrency] = useState("INR");
  const [interval, setBilled] = useState<"MONTH" | "YEAR">("MONTH");
  const [amount, setAmount] = useState("");
  const [perSeat, setPerSeat] = useState(false);
  const { run, pending, note } = useRun();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        // Typed in the currency's main unit; kept in its smallest.
        run(() => consoleAddPrice({ planKey, gateway, currency, interval, amount: Math.round(Number(amount) * 100), perSeat }), "Price made at the gateway and put on sale.");
      }}
    >
      <Select
        className="h-8 w-32"
        aria-label="Gateway"
        value={gateway}
        onChange={(e) => {
          const g = e.target.value === "STRIPE" ? "STRIPE" : "RAZORPAY";
          setGateway(g);
          if (g === "RAZORPAY") setCurrency("INR");
          else if (currency === "INR") setCurrency("USD");
        }}
      >
        <option value="RAZORPAY">Razorpay</option>
        <option value="STRIPE">Stripe</option>
      </Select>
      <Input className="h-8 w-20" aria-label="Currency" value={currency} disabled={gateway === "RAZORPAY"} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
      <Select className="h-8 w-28" aria-label="Billed" value={interval} onChange={(e) => setBilled(e.target.value === "YEAR" ? "YEAR" : "MONTH")}>
        <option value="MONTH">Monthly</option>
        <option value="YEAR">Yearly</option>
      </Select>
      <Input className="h-8 w-28" aria-label="Amount" type="number" min={0.01} step={0.01} placeholder="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <label className="inline-flex h-8 items-center gap-1 text-xs text-muted">
        <input type="checkbox" checked={perSeat} onChange={(e) => setPerSeat(e.target.checked)} /> per person
      </label>
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !(Number(amount) > 0)}>
        {pending ? "Making…" : "Add price"}
      </Button>
      {note}
    </form>
  );
}

export function TrialEndForm({ tenantId, endsOn }: { tenantId: string; endsOn: string | null }) {
  const [date, setDate] = useState(endsOn ?? "");
  const { run, pending, note } = useRun();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => consoleSetTrialEnd(tenantId, date), "The trial now ends then.");
      }}
    >
      <div>
        <Label htmlFor={`trial-${tenantId}`}>Trial ends on</Label>
        <Input id={`trial-${tenantId}`} className="h-8 w-44" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <Button type="submit" size="sm" variant="secondary" disabled={pending || !date}>
        {pending ? "Saving…" : "Set"}
      </Button>
      {note}
    </form>
  );
}
