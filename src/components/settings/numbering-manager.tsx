"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import type { TradeDocumentType } from "@prisma/client";
import { saveNumberSetting, listNumberSettings } from "@/actions/document-number";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { FY_TOKEN } from "@/lib/document-numbering";

type Setting = Awaited<ReturnType<typeof listNumberSettings>>[number];

/**
 * Every document type's number format in one table. The same settings the gear on a document form
 * opens — here so they can be set up once rather than discovered one document at a time.
 */
export function NumberingManager({ settings }: { settings: Setting[] }) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        How each document&apos;s number is built. <code className="text-xs">{FY_TOKEN}</code> becomes the financial
        year, so <code className="text-xs">WT/{FY_TOKEN}/QT/</code> renders as <code className="text-xs">WT/2026-27/QT/</code>.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Prefix</th>
              <th className="w-28 px-3 py-2">Next</th>
              <th className="w-20 px-3 py-2">Digits</th>
              <th className="px-3 py-2">Preview</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {settings.map((setting) => (
              <NumberingRow key={setting.docType} setting={setting} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NumberingRow({ setting }: { setting: Setting }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState(setting.mode);
  const [prefix, setPrefix] = useState(setting.prefix);
  const [nextNumber, setNextNumber] = useState(String(setting.nextNumber));
  const [padding, setPadding] = useState(String(setting.padding));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /**
   * Also the accessible name of every control in this row. The column headers are the only captions
   * here and a header cannot name a control, so each one carries an `aria-label` — and because the
   * table is one row per document type, that name has to say which document it belongs to or the
   * screen reader announces "Prefix" eleven times over.
   */
  const docLabel = tradeDocumentLabels[setting.docType];

  const dirty =
    mode !== setting.mode ||
    prefix !== setting.prefix ||
    Number(nextNumber) !== setting.nextNumber ||
    Number(padding) !== setting.padding;

  const preview =
    mode === "MANUAL"
      ? "Typed per document"
      : `${prefix.replaceAll(FY_TOKEN, "2026-27")}${String(Number(nextNumber) || 1).padStart(
          Math.max(Number(padding) || 1, 1),
          "0",
        )}`;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveNumberSetting({
        docType: setting.docType as TradeDocumentType,
        mode,
        prefix,
        nextNumber,
        padding,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className="px-3 py-2 font-medium text-text">{docLabel}</td>
      <td className="px-3 py-2">
        <Select
          value={mode}
          onChange={(e) => setMode(e.target.value as "AUTO" | "MANUAL")}
          className="h-8 w-28"
          aria-label={`Mode for ${docLabel}`}
        >
          <option value="AUTO">Auto</option>
          <option value="MANUAL">Manual</option>
        </Select>
      </td>
      <td className="px-3 py-2">
        <Input
          aria-label={`Prefix for ${docLabel}`}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          disabled={mode === "MANUAL"}
          className="h-8 font-mono"
          placeholder={`WT/${FY_TOKEN}/INV/`}
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="1"
          aria-label={`Next number for ${docLabel}`}
          value={nextNumber}
          onChange={(e) => setNextNumber(e.target.value)}
          disabled={mode === "MANUAL"}
          className="h-8 text-right"
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="1"
          max="10"
          aria-label={`Digits for ${docLabel}`}
          value={padding}
          onChange={(e) => setPadding(e.target.value)}
          disabled={mode === "MANUAL"}
          className="h-8 text-right"
        />
      </td>
      <td className="px-3 py-2">
        <span className="font-mono text-xs text-muted">{preview}</span>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </td>
      <td className="px-3 py-2 text-right">
        {saved && !dirty ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        ) : (
          <Button size="sm" variant="secondary" disabled={!dirty || pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
      </td>
    </tr>
  );
}
