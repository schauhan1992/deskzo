"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Info } from "lucide-react";
import type { DocumentSeriesScope, TradeDocumentType } from "@prisma/client";
import {
  saveDocumentSeries,
  saveNumberSetting,
  setNumberingScope,
  type NumberSettingView,
  type SeriesView,
} from "@/actions/document-number";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import {
  BR_TOKEN,
  FY2_TOKEN,
  FY_TOKEN,
  GST_NUMBERED_TYPES,
  GST_TOKEN,
  buildDocumentNumber,
  derivedSeriesPrefix,
  gstNumberProblem,
  numberFormatWarning,
  numberScopeLabels,
  type PrefixContext,
} from "@/lib/document-numbering";
import { financialYearOf, shortFinancialYear } from "@/lib/gst-engine";
import { seriesOwner, type SeriesBranch } from "@/lib/trade-number";

const SCOPES: DocumentSeriesScope[] = ["COMPANY", "REGISTRATION", "BRANCH"];

/** What `{GST}` and `{BR}` print for numbers raised at this branch — as allocation expands them. */
function contextOf(branch: SeriesBranch | undefined): PrefixContext {
  return { branchCode: branch?.code ?? null, registrationCode: branch?.gstRegistration?.code ?? null };
}

type Owner = ReturnType<typeof seriesOwner> & { ctx: PrefixContext; isHeadOffice: boolean };

/**
 * The series a type counts in under this scope, one per owner, decided by `seriesOwner` as allocation
 * decides it. A registration several branches share is one owner, and its `{BR}` prints the first of
 * them — the order `listNumberSettings` and `setNumberingScope` use, head office first.
 */
function ownersOf(scope: "REGISTRATION" | "BRANCH", branches: SeriesBranch[], docType: TradeDocumentType): Owner[] {
  const owners = new Map<string, Owner>();
  for (const branch of branches) {
    const owner = seriesOwner(scope, branch, docType);
    if (!owners.has(owner.ref.ownerKey)) owners.set(owner.ref.ownerKey, { ...owner, ctx: contextOf(branch), isHeadOffice: branch.isHeadOffice });
  }
  return [...owners.values()];
}

/** A format's next number as typed so far, and what GST's 16-character rule says about it — as the save will. */
function describe(docType: TradeDocumentType, prefix: string, nextNumber: string, padding: string, ctx: PrefixContext, today: Date) {
  // Blanks as the save reads them: next number 1, four digits.
  const next = Math.max(Math.trunc(Number(nextNumber || 1)) || 1, 1);
  const digits = Math.min(Math.max(Math.trunc(Number(padding || 4)) || 1, 1), 10);
  const example = buildDocumentNumber(prefix, next, digits, today, ctx);
  return { example, problem: gstNumberProblem(docType, example), warning: numberFormatWarning(docType, prefix, next, digits, ctx) };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Why a GST document number would be refused, what will go wrong later, or how much of the 16 it uses. */
function NumberStatus({ docType, example, problem, warning }: { docType: TradeDocumentType; example: string; problem: string | null; warning: string | null }) {
  if (problem) return <p className="mt-1 text-xs text-danger">{problem}</p>;
  if (warning) return <p className="mt-1 text-xs text-warning">{warning}</p>;
  if (!GST_NUMBERED_TYPES.includes(docType)) return null;
  return <p className="mt-1 text-xs text-subtle">{example.length} of 16 characters</p>;
}

/**
 * Every document type's number format in one table. The same settings the gear on a document form
 * opens — here so they can be set up once rather than discovered one document at a time.
 *
 * With more than one branch or GST registration, each type also chooses whose series it counts in
 * (spec §6.2), and a per-registration or per-branch type lists its series underneath.
 */
export function NumberingManager({
  settings,
  multi,
  branches,
  activeRegistrations,
}: {
  settings: NumberSettingView[];
  /** More than one active branch or registration: only then is there a choice of series. */
  multi: boolean;
  /** Active branches, head office first, as allocation reads them. */
  branches: SeriesBranch[];
  activeRegistrations: number;
}) {
  // One clock for every example on the screen: {FY} prints today's financial year.
  const [today] = useState(() => new Date());
  const columns = multi ? 8 : 7;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        How each document&apos;s number is built. In a prefix, <code className="text-xs">{FY_TOKEN}</code> becomes the
        financial year ({financialYearOf(today)}) and <code className="text-xs">{FY2_TOKEN}</code> its short form (
        {shortFinancialYear(today)}), so <code className="text-xs">WT/{FY_TOKEN}/QT/</code> renders as{" "}
        <code className="text-xs">WT/{financialYearOf(today)}/QT/</code>. <code className="text-xs">{GST_TOKEN}</code> becomes
        the GST registration&apos;s code and <code className="text-xs">{BR_TOKEN}</code> the branch&apos;s — those two
        are for per-registration and per-branch series. Tax invoices, credit notes and delivery challans must fit
        GST&apos;s 16 characters.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Document</th>
              {multi && <th className="px-3 py-2">Series</th>}
              <th className="px-3 py-2">Mode</th>
              <th className="px-3 py-2">Prefix</th>
              <th className="w-28 px-3 py-2">Next</th>
              <th className="w-20 px-3 py-2">Digits</th>
              <th className="px-3 py-2">Preview</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          {settings.map((setting) => (
            // Keyed by scope as well: switching can move the company counter (back to one series), and
            // the row then starts again from what was saved rather than keeping a stale next number.
            <NumberingType
              key={`${setting.docType}:${setting.scope}`}
              setting={setting}
              multi={multi}
              branches={branches}
              // CA question C1, owner decision Q6: advise per-GSTIN series, never switch on anyone's behalf.
              adviseSeries={multi && activeRegistrations > 1 && GST_NUMBERED_TYPES.includes(setting.docType)}
              columns={columns}
              today={today}
            />
          ))}
        </table>
      </div>
    </div>
  );
}

function NumberingType({
  setting,
  multi,
  branches,
  adviseSeries,
  columns,
  today,
}: {
  setting: NumberSettingView;
  multi: boolean;
  branches: SeriesBranch[];
  adviseSeries: boolean;
  columns: number;
  today: Date;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mode, setMode] = useState(setting.mode);
  const [prefix, setPrefix] = useState(setting.prefix);
  const [nextNumber, setNextNumber] = useState(String(setting.nextNumber));
  const [padding, setPadding] = useState(String(setting.padding));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const docType = setting.docType;
  /**
   * Also the accessible name of every control in this row. The column headers are the only captions
   * here and a header cannot name a control, so each one carries an `aria-label` — and because the
   * table is one row per document type, that name has to say which document it belongs to or the
   * screen reader announces "Prefix" eleven times over.
   */
  const docLabel = tradeDocumentLabels[docType];
  /** Numbered per registration or per branch: this row's format is then only the template new series start from. */
  const perSeries = setting.scope !== "COMPANY";
  const owners = setting.scope === "COMPANY" ? [] : ownersOf(setting.scope, branches, docType);

  const dirty =
    mode !== setting.mode ||
    prefix !== setting.prefix ||
    Number(nextNumber) !== setting.nextNumber ||
    Number(padding) !== setting.padding;
  // What was saved is the server's to describe; an edit is described here, the same way the save will.
  const status = dirty ? describe(docType, prefix, nextNumber, padding, contextOf(branches.find((b) => b.isHeadOffice)), today) : setting;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveNumberSetting({ docType, mode, prefix, nextNumber, padding });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <tbody className="border-b border-line last:border-0">
      <tr className="align-top">
        <td className="px-3 py-2 font-medium text-text">{docLabel}</td>
        {multi && (
          <td className="px-3 py-2">
            <ScopePicker setting={setting} docLabel={docLabel} branches={branches} adviseSeries={adviseSeries} today={today} />
          </td>
        )}
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
            aria-label={perSeries ? `Template prefix for ${docLabel}` : `Prefix for ${docLabel}`}
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            disabled={mode === "MANUAL"}
            className="h-8 font-mono"
            placeholder={`WT/${FY_TOKEN}/INV/`}
          />
          {perSeries && <p className="mt-1 text-xs text-subtle">The template new series start from</p>}
        </td>
        <td className="px-3 py-2">
          {/* Stopped while the type counts per series: each series below has its own. Switching back takes the higher. */}
          <Input
            type="number"
            min="1"
            aria-label={`Next number for ${docLabel}`}
            value={nextNumber}
            onChange={(e) => setNextNumber(e.target.value)}
            disabled={mode === "MANUAL" || perSeries}
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
          {mode === "MANUAL" ? (
            <span className="font-mono text-xs text-muted">Typed per document</span>
          ) : perSeries ? (
            <span className="text-xs text-muted">Per series, below</span>
          ) : (
            <>
              <span className="font-mono text-xs text-muted">{status.example}</span>
              <NumberStatus docType={docType} example={status.example} problem={status.problem} warning={status.warning} />
            </>
          )}
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
      {adviseSeries && setting.scope === "COMPANY" && (
        <tr>
          <td colSpan={columns} className="px-3 pb-2 pt-0">
            <p className="flex items-start gap-1.5 text-xs text-info">
              <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              Each GSTIN usually needs its own consecutive series — ask your CA.
            </p>
          </td>
        </tr>
      )}
      {perSeries && (
        <tr>
          <td colSpan={columns} className="px-3 pb-3 pt-0">
            {setting.series.length === 0 ? (
              <p className="text-xs text-muted">No active branch has a series of its own yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-sm">
                  <caption className="sr-only">{`${docLabel} series`}</caption>
                  <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-1.5">Series</th>
                      <th className="px-3 py-1.5">Prefix</th>
                      <th className="w-28 px-3 py-1.5">Next</th>
                      <th className="w-20 px-3 py-1.5">Digits</th>
                      <th className="px-3 py-1.5">Preview</th>
                      <th className="px-3 py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {setting.series.map((series) => (
                      <SeriesRow
                        key={series.ownerKey}
                        docType={docType}
                        docLabel={docLabel}
                        series={series}
                        manual={mode === "MANUAL"}
                        ctx={owners.find((o) => o.ref.ownerKey === series.ownerKey)?.ctx ?? {}}
                        today={today}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </td>
        </tr>
      )}
    </tbody>
  );
}

/**
 * Whose series the type counts in. Changing it is a statutory decision that moves counters (spec
 * §6.6), so the select only proposes: the dialog says what will happen, and the server's refusal —
 * duplicate prefixes, a number over 16 characters — is shown as it words it.
 */
function ScopePicker({
  setting,
  docLabel,
  branches,
  adviseSeries,
  today,
}: {
  setting: NumberSettingView;
  docLabel: string;
  branches: SeriesBranch[];
  adviseSeries: boolean;
  today: Date;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState<DocumentSeriesScope | null>(null);
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    if (!target) return;
    setError(null);
    startTransition(async () => {
      const result = await setNumberingScope(setting.docType, target);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setTarget(null);
      router.refresh();
    });
  }

  function cancel() {
    setTarget(null);
    setError(null);
  }

  return (
    <>
      <Select
        value={target ?? setting.scope}
        onChange={(e) => {
          setError(null);
          setTarget(e.target.value as DocumentSeriesScope);
        }}
        className="h-8 w-52"
        aria-label={`Series for ${docLabel}`}
      >
        {SCOPES.map((scope) => (
          <option key={scope} value={scope}>
            {numberScopeLabels[scope]}
          </option>
        ))}
      </Select>
      <Dialog
        open={target !== null}
        onClose={cancel}
        title={target ? `${docLabel} numbering: ${lowerFirst(numberScopeLabels[target])}` : docLabel}
      >
        {target && <ScopeChange setting={setting} target={target} branches={branches} adviseSeries={adviseSeries} today={today} />}
        {error && <p className="mt-3 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={cancel} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={confirm} disabled={pending}>
            {pending ? "Switching…" : "Switch"}
          </Button>
        </div>
      </Dialog>
    </>
  );
}

/** What switching to `target` does, in the numbers this workspace would actually see (spec §6.6). */
function ScopeChange({
  setting,
  target,
  branches,
  adviseSeries,
  today,
}: {
  setting: NumberSettingView;
  target: DocumentSeriesScope;
  branches: SeriesBranch[];
  adviseSeries: boolean;
  today: Date;
}) {
  const docType = setting.docType;
  const companyCtx = contextOf(branches.find((b) => b.isHeadOffice));
  const headOfficeSeries = setting.series.find((s) => s.isHeadOffice);
  const noun = (scope: DocumentSeriesScope) => (scope === "REGISTRATION" ? "GST registrations" : "branches");

  if (target === "COMPANY") {
    const continuesAt = buildDocumentNumber(
      setting.prefix,
      Math.max(setting.nextNumber, headOfficeSeries?.nextNumber ?? 0),
      setting.padding,
      today,
      companyCtx,
    );
    return (
      <div className="space-y-2 text-sm text-muted">
        <p>
          Every branch numbers from one company series again, continuing at{" "}
          <span className="font-mono text-text">{continuesAt}</span>, so the head office reuses nothing.
        </p>
        <p>
          The other {noun(setting.scope)}&apos; series stop where they are and are kept; their numbering joins the
          company series.
        </p>
        <p>Numbers already issued never change.</p>
        {adviseSeries && <p className="text-info">Each GSTIN usually needs its own consecutive series — ask your CA.</p>}
      </div>
    );
  }

  // Where the head office's numbers stand now: the company series, or its own under the current scope.
  const headOfficeNow =
    setting.scope === "COMPANY" || !headOfficeSeries
      ? buildDocumentNumber(setting.prefix, setting.nextNumber, setting.padding, today, companyCtx)
      : headOfficeSeries.example;
  const others = ownersOf(target, branches, docType).filter((o) => !o.isHeadOffice);
  const first = others[0];
  const firstNumber = first
    ? buildDocumentNumber(derivedSeriesPrefix(setting.prefix, first.ownerScope), 1, setting.padding, today, first.ctx)
    : null;
  const firstProblem = first && firstNumber && setting.mode === "AUTO" ? gstNumberProblem(docType, firstNumber) : null;

  return (
    <div className="space-y-2 text-sm text-muted">
      <p>
        The head office continues from <span className="font-mono text-text">{headOfficeNow}</span>.
      </p>
      {first && firstNumber ? (
        <p>
          Other {noun(target)} start at 1, with numbers like <span className="font-mono text-text">{firstNumber}</span> for{" "}
          {first.ownerLabel}. A series used before carries on from where it stopped.
        </p>
      ) : (
        <p>
          No other {target === "REGISTRATION" ? "GST registration" : "branch"} counts separately yet. One added later
          starts at 1, with a prefix like <span className="font-mono text-text">{derivedSeriesPrefix(setting.prefix, target)}</span>.
        </p>
      )}
      {first && firstProblem && (
        <p className="text-danger">
          {first.ownerLabel} would start at {firstNumber}. {firstProblem}
        </p>
      )}
      <p>Numbers already issued never change.</p>
    </div>
  );
}

/** One registration's or branch's series of a type, saved on its own. */
function SeriesRow({
  docType,
  docLabel,
  series,
  manual,
  ctx,
  today,
}: {
  docType: TradeDocumentType;
  docLabel: string;
  series: SeriesView;
  /** The type is numbered by hand: its series' formats are kept but not used. */
  manual: boolean;
  ctx: PrefixContext;
  today: Date;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [prefix, setPrefix] = useState(series.prefix);
  const [nextNumber, setNextNumber] = useState(String(series.nextNumber));
  const [padding, setPadding] = useState(String(series.padding));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  /** Every control's accessible name says which document and which series it belongs to. */
  const name = `${docLabel}, ${series.ownerLabel}`;
  const dirty = prefix !== series.prefix || Number(nextNumber) !== series.nextNumber || Number(padding) !== series.padding;
  const status = dirty ? describe(docType, prefix, nextNumber, padding, ctx, today) : series;

  function save() {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveDocumentSeries({
        docType,
        ownerKey: series.ownerKey,
        gstRegistrationId: series.gstRegistrationId ?? "",
        branchId: series.branchId ?? "",
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
    <tr className="border-t border-line align-top">
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5 text-text">
          {series.ownerLabel}
          {/* A branch-owned head office series is already labelled "Head office". */}
          {series.isHeadOffice && series.ownerKind === "REGISTRATION" && <Badge tone="brand">Head office</Badge>}
        </div>
        {!series.exists && <p className="mt-0.5 text-xs text-subtle">Not used yet — starts with these values</p>}
      </td>
      <td className="px-3 py-2">
        <Input
          aria-label={`Prefix for ${name}`}
          value={prefix}
          onChange={(e) => setPrefix(e.target.value)}
          disabled={manual}
          className="h-8 font-mono"
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="1"
          aria-label={`Next number for ${name}`}
          value={nextNumber}
          onChange={(e) => setNextNumber(e.target.value)}
          disabled={manual}
          className="h-8 text-right"
        />
      </td>
      <td className="px-3 py-2">
        <Input
          type="number"
          min="1"
          max="10"
          aria-label={`Digits for ${name}`}
          value={padding}
          onChange={(e) => setPadding(e.target.value)}
          disabled={manual}
          className="h-8 text-right"
        />
      </td>
      <td className="px-3 py-2">
        {manual ? (
          <span className="font-mono text-xs text-muted">Typed per document</span>
        ) : (
          <>
            <span className="font-mono text-xs text-muted">{status.example}</span>
            <NumberStatus docType={docType} example={status.example} problem={status.problem} warning={status.warning} />
          </>
        )}
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
