"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import type { TradeDocumentType } from "@prisma/client";
import { saveNumberSetting, previewNextNumber } from "@/actions/document-number";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { FY_TOKEN } from "@/lib/document-numbering";

export type NumberSetting = {
  mode: "AUTO" | "MANUAL";
  prefix: string;
  nextNumber: number;
  padding: number;
};

/**
 * The gear beside a document's number: switch between auto-generated and typed-by-hand, and set the
 * prefix and next serial. Matches how Zoho Books does it, because a business's number format is
 * usually inherited from whatever it billed with before and isn't ours to impose.
 */
export function NumberSettingsDialog({
  docType,
  setting,
  onApplied,
}: {
  docType: TradeDocumentType;
  setting: NumberSetting;
  /** Called with the freshly generated number so the open form can adopt it. */
  onApplied: (nextNumber: string, mode: "AUTO" | "MANUAL") => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"AUTO" | "MANUAL">(setting.mode);
  const [prefix, setPrefix] = useState(setting.prefix);
  const [nextNumber, setNextNumber] = useState(String(setting.nextNumber));
  const [padding, setPadding] = useState(String(setting.padding));

  const preview = `${prefix.replaceAll(FY_TOKEN, "2026-27")}${String(Number(nextNumber) || 1).padStart(
    Math.max(Number(padding) || 1, 1),
    "0",
  )}`;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveNumberSetting({ docType, mode, prefix, nextNumber, padding });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Auto mode hands the form the number it would generate, so the field reflects the new format
      // straight away rather than keeping whatever the old one produced.
      const generated = mode === "AUTO" ? await previewNextNumber(docType) : "";
      onApplied(generated, mode);
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        aria-label="Number preferences"
        title="Number preferences"
        className="shrink-0 text-subtle hover:text-text"
        onClick={() => setOpen(true)}
      >
        <Settings className="h-4 w-4" />
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title={`${tradeDocumentLabels[docType]} number preferences`}>
        <div className="space-y-4">
          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              checked={mode === "AUTO"}
              onChange={() => setMode("AUTO")}
              className="mt-1 h-4 w-4 accent-[var(--brand)]"
            />
            <span>
              <span className="block text-sm font-medium text-text">Continue auto-generating numbers</span>
              <span className="block text-xs text-subtle">
                Built from the prefix and a running serial, so nobody has to remember where they got to.
              </span>
            </span>
          </label>

          {mode === "AUTO" && (
            <div className="grid grid-cols-3 gap-3 pl-7">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="prefix">Prefix</Label>
                <Input id="prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="WT/{FY}/QT/" />
                <p className="text-xs text-subtle">
                  <code>{FY_TOKEN}</code> becomes the financial year.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nextNumber">Next number</Label>
                <Input
                  id="nextNumber"
                  type="number"
                  min="1"
                  value={nextNumber}
                  onChange={(e) => setNextNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="padding">Digits</Label>
                <Input
                  id="padding"
                  type="number"
                  min="1"
                  max="10"
                  value={padding}
                  onChange={(e) => setPadding(e.target.value)}
                />
              </div>
              <div className="col-span-2 self-end rounded-base border border-line bg-surface-sunken px-3 py-2">
                <span className="text-xs uppercase tracking-wide text-subtle">Preview</span>
                <div className="font-mono text-sm text-text">{preview}</div>
              </div>
            </div>
          )}

          <label className="flex items-start gap-2.5">
            <input
              type="radio"
              checked={mode === "MANUAL"}
              onChange={() => setMode("MANUAL")}
              className="mt-1 h-4 w-4 accent-[var(--brand)]"
            />
            <span>
              <span className="block text-sm font-medium text-text">Enter numbers manually</span>
              <span className="block text-xs text-subtle">
                Type each one. Uniqueness is still enforced, but keeping the sequence unbroken is on you —
                GST expects a consecutive series.
              </span>
            </span>
          </label>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button type="button" onClick={save} disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
