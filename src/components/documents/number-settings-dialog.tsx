"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import type { TradeDocumentType } from "@prisma/client";
import { previewNextNumber, saveDocumentSeries, saveNumberSetting } from "@/actions/document-number";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import {
  BR_TOKEN,
  FY2_TOKEN,
  FY_TOKEN,
  GST_NUMBERED_TYPES,
  GST_TOKEN,
  buildDocumentNumber,
  gstNumberProblem,
  numberFormatWarning,
  type PrefixContext,
} from "@/lib/document-numbering";
import { financialYearOf, shortFinancialYear } from "@/lib/gst-engine";

/**
 * The series a document raised at one branch takes its number from: `getNumberSetting(docType, branchId)`'s
 * result, passed as it comes.
 *
 * Under `COMPANY` scope the format is the type's own; under `REGISTRATION` or `BRANCH` it is the series
 * of `ownerKey` (`ownerLabel` names it), while `mode` stays the type's, shared by every series.
 */
export type NumberSetting = {
  mode: "AUTO" | "MANUAL";
  scope: "COMPANY" | "REGISTRATION" | "BRANCH";
  prefix: string;
  nextNumber: number;
  padding: number;
  seriesId: string | null;
  ownerKey: string | null;
  ownerLabel: string | null;
  /**
   * What `{GST}` and `{BR}` print for this branch. Optional because `getNumberSetting` does not return it
   * yet; without it, a prefix naming either token is previewed with the token shown and the 16-character
   * check is left to the save.
   */
  ctx?: PrefixContext | null;
  /**
   * Whether `ownerKey` is a registration's id or a branch's. Optional for the same reason; without it,
   * a per-branch scope, or an owner that is the chosen branch itself, is a branch, and otherwise a
   * registration — right whenever the form passes its `branchId`.
   */
  ownerKind?: "REGISTRATION" | "BRANCH" | null;
};

/** A prefix with only the year filled in — for previewing a format whose branch codes aren't known here. */
function withYear(prefix: string, date: Date) {
  return prefix.replaceAll(FY2_TOKEN, shortFinancialYear(date)).replaceAll(FY_TOKEN, financialYearOf(date));
}

/**
 * The gear beside a document's number: switch between auto-generated and typed-by-hand, and set the
 * prefix and next serial. Matches how Zoho Books does it, because a business's number format is
 * usually inherited from whatever it billed with before and isn't ours to impose.
 *
 * When the type is numbered per GST registration or per branch, it edits the series the chosen
 * branch's numbers come from, which is what `setting` describes.
 */
export function NumberSettingsDialog({
  docType,
  setting,
  branchId,
  onApplied,
}: {
  docType: TradeDocumentType;
  setting: NumberSetting;
  /** The branch the document is raised at; null or left out is the head office. Used for the preview after saving. */
  branchId?: string | null;
  /** Called with the freshly generated number so the open form can adopt it. */
  onApplied: (nextNumber: string, mode: "AUTO" | "MANUAL") => void;
}) {
  const router = useRouter();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"AUTO" | "MANUAL">(setting.mode);
  const [prefix, setPrefix] = useState(setting.prefix);
  const [nextNumber, setNextNumber] = useState(String(setting.nextNumber));
  const [padding, setPadding] = useState(String(setting.padding));
  const [today, setToday] = useState(() => new Date());

  /** A series of its own. With no head office yet a non-company scope still numbers from the company series. */
  const perSeries = setting.scope !== "COMPANY" && setting.ownerKey !== null;
  const ownerKind = setting.ownerKind ?? (setting.scope === "BRANCH" || setting.ownerKey === branchId ? "BRANCH" : "REGISTRATION");
  const label = tradeDocumentLabels[docType];

  // Blanks as the save reads them: next number 1, four digits.
  const next = Math.max(Math.trunc(Number(nextNumber || 1)) || 1, 1);
  const digits = Math.min(Math.max(Math.trunc(Number(padding || 4)) || 1, 1), 10);
  const ctx = setting.ctx ?? null;
  // Without the branch's codes a {GST} or {BR} would print as nothing, and the check would be of a number
  // nobody will issue — so the preview says which token goes there and the save does the checking.
  const codesUnknown = ctx === null && (prefix.includes(GST_TOKEN) || prefix.includes(BR_TOKEN));
  const preview = codesUnknown
    ? `${withYear(prefix, today)}${String(next).padStart(digits, "0")}`
    : buildDocumentNumber(prefix, next, digits, today, ctx ?? {});
  const problem = codesUnknown ? null : gstNumberProblem(docType, preview);
  const warning = codesUnknown ? null : numberFormatWarning(docType, prefix, next, digits, ctx ?? {});
  const gstNumbered = GST_NUMBERED_TYPES.includes(docType);
  const note =
    problem ??
    warning ??
    (codesUnknown
      ? `${GST_TOKEN} and ${BR_TOKEN} are filled in for this branch when a number is issued${gstNumbered ? ", and GST's 16-character limit is checked when you save" : ""}.`
      : gstNumbered
        ? `${preview.length} of the 16 characters GST allows.`
        : null);

  /**
   * Starts from the series the form is on now. The form hands in a new `setting` when its branch
   * changes, so the fields are filled on opening rather than kept from the first render.
   */
  function show() {
    setMode(setting.mode);
    setPrefix(setting.prefix);
    setNextNumber(String(setting.nextNumber));
    setPadding(String(setting.padding));
    setError(null);
    setToday(new Date());
    setOpen(true);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      if (perSeries) {
        // The mode is the type's: `{ docType, mode }` alone changes it without touching the template.
        // It goes first so the series below is checked as an auto-numbered one.
        if (mode !== setting.mode) {
          const result = await saveNumberSetting({ docType, mode });
          if (!result.ok) {
            setError(result.error);
            return;
          }
        }
        const changed = prefix !== setting.prefix || next !== setting.nextNumber || digits !== setting.padding;
        if (mode === "AUTO" && changed) {
          const result = await saveDocumentSeries({
            docType,
            ownerKey: setting.ownerKey,
            gstRegistrationId: ownerKind === "REGISTRATION" ? setting.ownerKey : "",
            branchId: ownerKind === "BRANCH" ? setting.ownerKey : "",
            prefix,
            nextNumber,
            padding,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
        }
      } else {
        const result = await saveNumberSetting({ docType, mode, prefix, nextNumber, padding });
        if (!result.ok) {
          setError(result.error);
          return;
        }
      }
      // Auto mode hands the form the number it would generate, so the field reflects the new format
      // straight away rather than keeping whatever the old one produced.
      const generated = mode === "AUTO" ? await previewNextNumber(docType, branchId ?? null) : "";
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
        onClick={show}
      >
        <Settings className="h-4 w-4" />
      </button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={perSeries ? `${label} numbering for ${setting.ownerLabel}` : `${label} number preferences`}
      >
        <div className="space-y-4">
          {perSeries && (
            <p className="text-xs text-subtle">
              {label} numbers are counted {setting.scope === "REGISTRATION" ? "per GST registration" : "per branch"}, and
              this is the series this branch uses. Automatic or manual applies to every series of the type.
            </p>
          )}

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
                <Label htmlFor={`${fieldId}-prefix`}>Prefix</Label>
                <Input
                  id={`${fieldId}-prefix`}
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  placeholder="WT/{FY}/QT/"
                  className="font-mono"
                />
                <p className="text-xs text-subtle">
                  <code>{FY_TOKEN}</code> becomes the financial year ({financialYearOf(today)}),{" "}
                  <code>{FY2_TOKEN}</code> the short year ({shortFinancialYear(today)})
                  {perSeries ? (
                    <>
                      , <code>{GST_TOKEN}</code> the GST registration&apos;s code
                      {ctx?.registrationCode ? ` (${ctx.registrationCode})` : ""} and <code>{BR_TOKEN}</code> the
                      branch&apos;s{ctx?.branchCode ? ` (${ctx.branchCode})` : ""}.
                    </>
                  ) : (
                    "."
                  )}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-next`}>Next number</Label>
                <Input
                  id={`${fieldId}-next`}
                  type="number"
                  min="1"
                  value={nextNumber}
                  onChange={(e) => setNextNumber(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-padding`}>Digits</Label>
                <Input
                  id={`${fieldId}-padding`}
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
              {note && (
                <p className={`col-span-3 text-xs ${problem ? "text-danger" : warning ? "text-warning" : "text-subtle"}`}>{note}</p>
              )}
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
