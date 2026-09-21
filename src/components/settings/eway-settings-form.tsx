"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveEwayThreshold, type EwaySettings } from "@/actions/eway";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { THRESHOLD } from "@/lib/eway/rules";

/** Rough guide only — states change these, and the app can't know which is current. */
const EXAMPLES = "₹1,00,000 in Maharashtra, ₹2,00,000 in Bihar, ₹50,000 in most others";

export function EwaySettingsForm({ settings }: { settings: EwaySettings }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [value, setValue] = useState(settings.intraStateThreshold ? String(settings.intraStateThreshold) : "");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);

  function save() {
    setBusy(true);
    setNotice(null);
    startTransition(async () => {
      const trimmed = value.trim();
      const result = await saveEwayThreshold({ intraStateThreshold: trimmed === "" ? null : Number(trimmed) });
      setBusy(false);
      if (!result.ok) {
        setNotice({ text: result.error, bad: true });
        return;
      }
      setNotice({ text: "Saved." });
      router.refresh();
    });
  }

  return (
    <div className="max-w-xl space-y-3">
      <div className="space-y-1">
        <Label htmlFor="eway-threshold">Threshold within {settings.stateCode ? "your state" : "your own state"}</Label>
        <Input
          id="eway-threshold"
          inputMode="decimal"
          value={value}
          placeholder={`Blank — use the central ₹${THRESHOLD.toLocaleString("en-IN")}`}
          onChange={(e) => setValue(e.target.value)}
        />
        <p className="text-xs text-muted">
          Applies only to movement that stays inside your state. Leave it blank unless your state has set a higher
          floor of its own ({EXAMPLES}). Anything crossing a state line always needs a bill above ₹
          {THRESHOLD.toLocaleString("en-IN")}, and that is not ours to change.
        </p>
      </div>

      {notice && (
        <p className={notice.bad ? "text-sm text-danger" : "text-sm text-success"}>{notice.text}</p>
      )}

      <div className="flex items-center gap-2">
        <Button disabled={busy} onClick={save}>
          Save threshold
        </Button>
        {settings.intraStateThreshold !== null && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setValue("");
              setBusy(true);
              startTransition(async () => {
                // The result was discarded and success reported regardless, so a refused write
                // looked exactly like one that landed — and the threshold silently stayed put.
                const result = await saveEwayThreshold({ intraStateThreshold: null });
                setBusy(false);
                if (!result.ok) {
                  setNotice({ text: result.error, bad: true });
                  return;
                }
                setNotice({ text: `Back to the central ₹${THRESHOLD.toLocaleString("en-IN")}.` });
                router.refresh();
              });
            }}
          >
            Use the central threshold
          </Button>
        )}
      </div>
    </div>
  );
}
