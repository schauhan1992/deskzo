"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { saveEwayThreshold, type EwayRegistrationSettings } from "@/actions/eway";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { THRESHOLD } from "@/lib/eway/rules";

/** Rough guide only — states change these, and the app can't know which is current. */
const EXAMPLES = "₹1,00,000 in Maharashtra, ₹2,00,000 in Bihar, ₹50,000 in most others";

const CENTRAL = `₹${THRESHOLD.toLocaleString("en-IN")}`;

/** Short names for the status line; the select on e-Invoicing has the long ones. */
const PROVIDER_LABELS: Record<string, string> = { mock: "Mock", nic_sandbox: "NIC sandbox", nic_production: "NIC production" };

/**
 * Each GST registration's portal status and its own intra-state floor.
 *
 * Per registration because each state sets its own floor for movement that stays inside it, and a
 * company registered in two states moves goods under both. Typed in by the user rather than looked
 * up — CA question C6.
 */
export function EwaySettingsForm({
  registrations,
  einvoiceEnabled,
}: {
  registrations: EwayRegistrationSettings[];
  /** The logins below are the e-invoice ones, used only while e-invoicing is on. */
  einvoiceEnabled: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">GSTIN</th>
              <th className="px-3 py-2">State</th>
              <th className="px-3 py-2">Portal</th>
              <th className="px-3 py-2">Threshold within the state</th>
            </tr>
          </thead>
          <tbody>
            {registrations.map((registration) => (
              <ThresholdRow key={registration.id} registration={registration} einvoiceEnabled={einvoiceEnabled} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Applies only to movement that stays inside the registration&apos;s state. Leave it blank unless that state has set a
        higher floor of its own ({EXAMPLES}). Anything crossing a state line always needs a bill above {CENTRAL}, and that is
        not ours to change.
      </p>
    </div>
  );
}

function ThresholdRow({ registration, einvoiceEnabled }: { registration: EwayRegistrationSettings; einvoiceEnabled: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const saved = registration.threshold !== null ? String(registration.threshold) : "";
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const state = GST_STATE_CODES[registration.stateCode] ?? registration.stateCode;

  function save(threshold: string | null, done: string) {
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      // Sent as typed: the action reads "1,00,000" as the amount it is, and blank as the central floor.
      const result = await saveEwayThreshold({ gstRegistrationId: registration.id, threshold });
      setBusy(false);
      if (!result.ok) {
        setNotice({ text: result.error, bad: true });
        return;
      }
      setNotice({ text: done });
      router.refresh();
    });
  }

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="px-3 py-2">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-text">{registration.gstin}</span>
          {registration.isHeadOffice && <Badge tone="brand">Head office</Badge>}
          {!registration.active && <Badge>Inactive</Badge>}
        </span>
      </td>
      <td className="px-3 py-2 text-text">{state}</td>
      <td className="px-3 py-2">
        <Link href="/settings/einvoicing" className="inline-flex hover:underline">
          {!registration.configured ? (
            <Badge tone="amber">Not set up</Badge>
          ) : einvoiceEnabled ? (
            <Badge tone="green">Connected</Badge>
          ) : (
            <Badge tone="amber">E-invoicing off</Badge>
          )}
        </Link>
        {registration.configured && (
          <span className="mt-1 block text-xs text-muted">
            {PROVIDER_LABELS[registration.provider ?? ""] ?? registration.provider}
            {registration.username && <span className="font-mono"> · {registration.username}</span>}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Threshold within ${state} for GSTIN ${registration.gstin}`}
            inputMode="decimal"
            value={value}
            placeholder={`Blank — the central ${CENTRAL}`}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-48"
          />
          <Button size="sm" disabled={busy || value.trim() === saved} onClick={() => save(value, "Saved.")}>
            Save
          </Button>
          {registration.threshold !== null && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setValue("");
                // The result is checked: a refused write reported as success would leave the old floor in place, unseen.
                save(null, `Back to the central ${CENTRAL}.`);
              }}
            >
              Use the central threshold
            </Button>
          )}
        </div>
        {notice && <p className={`mt-1 text-xs ${notice.bad ? "text-danger" : "text-success"}`}>{notice.text}</p>}
      </td>
    </tr>
  );
}
