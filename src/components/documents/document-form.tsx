"use client";

import type { CategoryWithParent } from "@/lib/customers/categories";
import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TradeDocumentType, CompanyRelationshipType } from "@prisma/client";
import { Plus, Trash2, Search } from "lucide-react";
import {
  createTradeDocument,
  updateTradeDocument,
  listPartyLocations,
  listDocumentItems,
  listCreditableInvoices,
} from "@/actions/trade-document";
import { getNumberSetting, previewNextNumber } from "@/actions/document-number";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox } from "@/components/ui/company-combobox";
import { AnchoredPopover } from "@/components/ui/anchored-popover";
import { AddressEditor } from "@/components/documents/address-editor";
import { NumberSettingsDialog, type NumberSetting } from "@/components/documents/number-settings-dialog";
import { formatCurrency } from "@/lib/utils";
import { computeDocument, resolveSupplyType, stateCodeFromGstin, GST_STATE_OPTIONS, OTHER_COUNTRY_CODE } from "@/lib/gst-engine";
import { isIndia } from "@/lib/geo/countries";
import { gstTreatmentValues, gstTreatmentLabels } from "@/lib/gst";
import { BASE_CURRENCY, CURRENCIES, getCurrency, isBaseCurrency, rateHint } from "@/lib/currency";
import { lookupExchangeRate } from "@/actions/exchange-rate";
import { documentDirection, documentListPath, tradeDocumentLabels } from "@/lib/trade-documents";
import { registeredTreatments } from "@/lib/validation/trade-document";
import { blankLine, type AddressDraft, type DocumentFormDefaults, type LineDraft } from "@/lib/document-draft";
import { branchLabel, type BranchChoice } from "@/lib/branches/format";
import { GST_NUMBERED_TYPES, expandPrefix } from "@/lib/document-numbering";
import { startOfIndianDay } from "@/lib/india-time";

type Party = { id: string; name: string; relationshipType: CompanyRelationshipType; customerCategory?: CategoryWithParent | null };
type PartyLocation = Awaited<ReturnType<typeof listPartyLocations>>[number];
type CatalogItem = Awaited<ReturnType<typeof listDocumentItems>>[number];
type CreditableInvoice = Awaited<ReturnType<typeof listCreditableInvoices>>[number];

const EMPTY_LOCATIONS: PartyLocation[] = [];
const GST_RATES = ["0", "0.25", "3", "5", "12", "18", "28"];

/**
 * Whether a stored number is one this series generated: its prefix, expanded for the document's date,
 * then digits only. The server's own test (`isAutoNumberOf`) for renumbering a moved draft — a number
 * somebody typed is never renumbered.
 */
function generatedBy(setting: NumberSetting, docNumber: string, issueDate: string) {
  const prefix = expandPrefix(setting.prefix, startOfIndianDay(issueDate) ?? new Date(), setting.ctx ?? {});
  return docNumber.startsWith(prefix) && /^\d+$/.test(docNumber.slice(prefix.length));
}

export function DocumentForm({
  docType,
  parties,
  branches,
  defaultTerms,
  roundOffTotals,
  numberSetting,
  salespeople,
  defaults,
}: {
  docType: TradeDocumentType;
  parties: Party[];
  salespeople: { id: string; name: string; email?: string | null; phone?: string | null }[];
  /**
   * Where the document can be raised from (on a purchase, who is buying): the active branches, head
   * office first, plus an edited draft's own if it has since been deactivated. The picker shows only
   * when there is a choice, so a single-branch company sees the form it always had.
   */
  branches: BranchChoice[];
  /** The organisation's terms — the fallback for a branch without its own. */
  defaultTerms: string | null;
  roundOffTotals: boolean;
  /** The series the starting branch numbers from: `getNumberSetting(docType, defaults.branchId)`. */
  numberSetting: NumberSetting;
  defaults: DocumentFormDefaults;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** Prefix for ids that tie captions to their controls, unique per mount of this form. */
  const fieldId = useId();

  const headOfficeId = branches.find((b) => b.isHeadOffice)?.id ?? "";
  /** Where this form started: the draft's branch, or the writer's own, else the head office. */
  const startBranchId = defaults.branchId || headOfficeId || branches[0]?.id || "";
  const [branchId, setBranchId] = useState(startBranchId);
  /** Declared after the state it reads, like `chosenSalesperson` below. Unset only for a credit note
   *  whose invoice came from a branch since deactivated, which the picker names without its details. */
  const selectedBranch = branches.find((b) => b.id === branchId);
  /** Our side's GST state: the branch's registration, else its address — what decides CGST+SGST or IGST. */
  const sellerStateCode = selectedBranch?.stateCode ?? null;
  const gstNumbered = GST_NUMBERED_TYPES.includes(docType);

  const [docNumber, setDocNumber] = useState(defaults.docNumber);
  const [numberMode, setNumberMode] = useState(numberSetting.mode);
  /**
   * The series the chosen branch numbers from (what the gear edits) and its next number. Swapped when
   * the branch changes, since per-GSTIN or per-branch numbering gives each branch its own.
   */
  const [series, setSeries] = useState({ branchId: startBranchId, setting: numberSetting, preview: defaults.docNumber });
  /**
   * The number this form generated and put in the field, while it is still there — a new document's
   * preview, or one the gear produced. A number that no longer matches was typed, and is left alone
   * when the branch changes. Null on an edit: the stored number is the server's to renumber.
   */
  const [generatedNumber, setGeneratedNumber] = useState<string | null>(defaults.id ? null : defaults.docNumber);
  const [numberLoading, startNumberLookup] = useTransition();
  /** Which branch change is the latest, so a slower answer for an earlier one is dropped. */
  const numberRequest = useRef(0);
  const [companyId, setCompanyId] = useState(defaults.companyId);
  const [fetchedLocations, setFetchedLocations] = useState<{ companyId: string; rows: PartyLocation[] }>({
    companyId: "",
    rows: EMPTY_LOCATIONS,
  });
  const [locationId, setLocationId] = useState(defaults.locationId);
  const [gstTreatment, setGstTreatment] = useState(defaults.gstTreatment);
  const [currency, setCurrency] = useState(defaults.currency ?? BASE_CURRENCY);
  const [exchangeRate, setExchangeRate] = useState(String(defaults.exchangeRate ?? 1));
  const [rateNote, setRateNote] = useState<string | null>(null);
  const [rateLoading, startRateLookup] = useTransition();
  /** Set the moment somebody edits the field, so a later lookup never overwrites their figure. */
  const [rateTouched, setRateTouched] = useState(false);

  /** Every figure on this document, in the currency the customer will read it in. */
  const money = (value: number | string | null | undefined) => formatCurrency(value, currency);
  const symbol = getCurrency(currency).symbol;

  /**
   * A rupee catalogue price, in the currency of this document.
   *
   * Rounded to the currency's own precision rather than left at eight decimal places — a quote
   * reading $870.87 is one somebody can discuss; $870.8708708 is one they query.
   */
  /**
   * Ask what the currency was worth on the document's own date.
   *
   * Never overwrites a figure somebody typed: the looked-up rate is a starting point and the
   * agreed rate is the one that counts. Failure is reported in the hint line and nothing else
   * happens — the field still works.
   */
  function fetchRate(code: string, onDate: string, force = false) {
    if (isBaseCurrency(code) || !onDate) return;
    if (rateTouched && !force) return;
    setRateNote("Looking up the rate…");
    startRateLookup(async () => {
      const result = await lookupExchangeRate(code, onDate);
      if (!result.ok) {
        setRateNote(result.reason);
        return;
      }
      setExchangeRate(String(result.rate));
      setRateTouched(false);
      setRateNote(`${result.source}, ${result.onDate}`);
    });
  }

  function catalogPriceInDocumentCurrency(rupees: number): number {
    const rate = Number(exchangeRate) || 1;
    if (isBaseCurrency(currency) || rate <= 0) return rupees;
    const places = getCurrency(currency).decimals;
    const factor = 10 ** places;
    return Math.round((rupees / rate) * factor) / factor;
  }
  const [buyerGstin, setBuyerGstin] = useState(defaults.buyerGstin);
  const [placeOverride, setPlaceOverride] = useState(defaults.placeOfSupplyCode);
  const [placeTouched, setPlaceTouched] = useState(!!defaults.placeOfSupplyCode);
  const [reverseCharge, setReverseCharge] = useState(defaults.reverseCharge);
  const [issueDate, setIssueDate] = useState(defaults.issueDate);
  const [dueDate, setDueDate] = useState(defaults.dueDate);
  const [validUntil, setValidUntil] = useState(defaults.validUntil);
  const [reference, setReference] = useState(defaults.reference);
  const [salespersonId, setSalespersonId] = useState(defaults.salespersonId);
  /** Declared after the state it reads: `.find()` runs during render, so hoisting it above the
   *  `useState` throws on the dead zone rather than reading an undefined. */
  const chosenSalesperson = salespeople.find((p) => p.id === salespersonId);
  const [notes, setNotes] = useState(defaults.notes);
  const [terms, setTerms] = useState(defaults.terms || selectedBranch?.invoiceTerms || defaultTerms || "");

  const [dispatchFrom, setDispatchFrom] = useState(defaults.dispatchFromAddress || selectedBranch?.dispatchAddress || "");
  const [billing, setBilling] = useState<AddressDraft>(defaults.billing);
  /**
   * Once someone edits the address by hand, an arriving location must not overwrite it. Held in a
   * ref as well as state because the locations effect reads it from inside an async callback, where
   * a captured state value would be whatever it was when the fetch started.
   */
  const [billingTouched, setBillingTouched] = useState(!!defaults.id);
  const billingTouchedRef = useRef(billingTouched);
  billingTouchedRef.current = billingTouched;
  const locationIdRef = useRef(defaults.locationId);
  const [shippingSame, setShippingSame] = useState(defaults.shippingSameAsBilling);
  const [shipping, setShipping] = useState<AddressDraft>(defaults.shipping);
  const [shippingGstin, setShippingGstin] = useState(defaults.shippingGstin);

  const [shippingCharge, setShippingCharge] = useState(defaults.shippingCharge);
  const [shippingTaxRate, setShippingTaxRate] = useState(defaults.shippingTaxRatePercent);
  const [withholdingMode, setWithholdingMode] = useState(defaults.withholdingMode);
  const [withholdingSection, setWithholdingSection] = useState(defaults.withholdingSection);
  const [withholdingRate, setWithholdingRate] = useState(defaults.withholdingRatePercent);
  const [adjustmentLabel, setAdjustmentLabel] = useState(defaults.adjustmentLabel);
  const [adjustment, setAdjustment] = useState(defaults.adjustment);

  const [againstDocumentId, setAgainstDocumentId] = useState(defaults.againstDocumentId);
  const [fetchedCreditable, setFetchedCreditable] = useState<{ companyId: string; rows: CreditableInvoice[] }>({
    companyId: "",
    rows: [],
  });
  const [lines, setLines] = useState<LineDraft[]>(defaults.lines.length > 0 ? defaults.lines : [blankLine()]);

  const isSales = documentDirection[docType] === "SALES";
  const isCreditNote = docType === "CREDIT_NOTE";
  const gstinRequired = registeredTreatments.includes(gstTreatment as (typeof registeredTreatments)[number]);

  // Locations decide the default addresses and the place of supply, so they're fetched as soon as a
  // party is picked rather than shipping every company's down to the browser.
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    listPartyLocations(companyId).then((rows) => {
      if (cancelled) return;
      setFetchedLocations({ companyId, rows });
      const keep = rows.find((r) => r.id === locationIdRef.current);
      const chosen = keep ?? rows[0] ?? null;
      setLocationId(chosen?.id ?? "");
      // Only when nobody has hand-edited the address — re-adopting would discard their edit.
      if (!billingTouchedRef.current) adoptLocation(chosen);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  useEffect(() => {
    if (!isCreditNote || !companyId) return;
    let cancelled = false;
    listCreditableInvoices(companyId).then((rows) => {
      if (!cancelled) setFetchedCreditable({ companyId, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, isCreditNote]);

  locationIdRef.current = locationId;

  const locations = fetchedLocations.companyId === companyId ? fetchedLocations.rows : EMPTY_LOCATIONS;
  const creditable = fetchedCreditable.companyId === companyId ? fetchedCreditable.rows : [];

  const partyStateCode =
    billing.stateCode ||
    stateCodeFromGstin(buyerGstin) ||
    null;

  // The place of supply follows the billing state until someone overrides it — a bill-to/ship-to
  // split is real but uncommon, and defaulting it wrong taxes the whole document incorrectly. On a
  // purchase it is the buying branch's own state, as the server defaults it.
  const placeOfSupplyCode = placeTouched ? placeOverride : ((isSales ? partyStateCode : sellerStateCode) ?? "");
  const supplyType = resolveSupplyType(isSales ? sellerStateCode : partyStateCode, placeOfSupplyCode || null);

  // A credit note is raised by the branch that issued its invoice; once one is chosen, the picker
  // shows that branch and can't be changed (the server refuses any other).
  const followsInvoice = isCreditNote && Boolean(againstDocumentId);

  /**
   * Editing a draft: moving it to a branch that numbers in another series renumbers it when saved,
   * and the old number is left as a gap (owner decision Q9, CA question C2). The server's rule,
   * shown in advance — only for a number its old series generated, and only while it is left as stored.
   */
  const renumbering =
    defaults.id !== undefined &&
    series.branchId !== startBranchId &&
    series.setting.ownerKey !== numberSetting.ownerKey &&
    docNumber.trim() === defaults.docNumber &&
    generatedBy(numberSetting, defaults.docNumber, defaults.issueDate);

  /**
   * Moves the document to another branch. An event, so everything that follows the branch is set here
   * rather than mirrored in an effect. The dispatch-from address and the terms follow it unless
   * somebody wrote their own — text that still reads as the old branch filled it in, or is blank,
   * counts as untouched (on an edited draft too, where a flag set at load could only guess).
   */
  function chooseBranch(nextId: string) {
    if (!nextId || nextId === branchId) return;
    const from = selectedBranch;
    const to = branches.find((b) => b.id === nextId);
    setBranchId(nextId);
    if (to) {
      if (!dispatchFrom.trim() || dispatchFrom === (from?.dispatchAddress ?? "")) setDispatchFrom(to.dispatchAddress);
      const termsOf = (b: BranchChoice | undefined) => b?.invoiceTerms ?? defaultTerms ?? "";
      if (!terms.trim() || terms === termsOf(from)) setTerms(termsOf(to));
    }
    followSeries(nextId);
  }

  /**
   * The chosen branch's numbering: the series the gear edits and, when the field still holds the
   * number this form generated, that series' next number in its place (`adopt`). An answer that
   * arrives after a later change is dropped, as the locations effect drops a superseded party's.
   */
  function followSeries(forBranchId: string, adopt = true) {
    const ticket = ++numberRequest.current;
    const shown = docNumber;
    const replace = adopt && numberMode === "AUTO" && generatedNumber !== null && docNumber === generatedNumber;
    startNumberLookup(async () => {
      const [setting, preview] = await Promise.all([
        getNumberSetting(docType, forBranchId || null),
        previewNextNumber(docType, forBranchId || null),
      ]);
      if (ticket !== numberRequest.current) return;
      setSeries({ branchId: forBranchId, setting, preview });
      setNumberMode(setting.mode);
      if (replace && setting.mode === "AUTO" && preview) {
        // Only over the generated number: one typed while this was on its way is theirs.
        setDocNumber((current) => (current === shown ? preview : current));
        setGeneratedNumber(preview);
      }
    });
  }

  /** Pulls the billing address and GST details from a location the user just chose. */
  function adoptLocation(location: PartyLocation | null) {
    if (!location) return;
    const abroad = !isIndia(location.country);
    // Abroad is "Other Country" (96); a foreign state name is never matched against India's list.
    const stateCode =
      stateCodeFromGstin(location.gstNumber) ??
      (abroad ? OTHER_COUNTRY_CODE : GST_STATE_OPTIONS.find((s) => s.name.toLowerCase() === (location.state ?? "").trim().toLowerCase())?.code) ??
      "";
    const next: AddressDraft = {
      attention: "",
      line1: location.address ?? "",
      line2: "",
      city: location.city ?? "",
      state: location.state ?? "",
      stateCode,
      pincode: location.pincode ?? "",
      // The location's own country — this said "India" whatever the address was.
      country: abroad ? (location.country ?? "").trim() : "India",
      phone: "",
    };
    setBilling(next);
    if (shippingSame) setShipping(next);
    // The treatment follows the registration: a location with a GSTIN on file is a registered party.
    if (location.gstNumber) {
      setBuyerGstin(location.gstNumber);
      setGstTreatment("REGISTERED_REGULAR");
    } else {
      setBuyerGstin("");
      setGstTreatment("UNREGISTERED");
    }
  }

  const totals = useMemo(
    () =>
      computeDocument(
        lines.map((l) => ({
          quantity: Number(l.quantity) || 0,
          unitPrice: Number(l.unitPrice) || 0,
          discountMode: l.discountMode === "AMOUNT" ? ("AMOUNT" as const) : ("PERCENT" as const),
          discountValue: Number(l.discountValue) || 0,
          taxRatePercent: Number(l.taxRatePercent) || 0,
        })),
        supplyType,
        {
          shippingCharge: Number(shippingCharge) || 0,
          shippingTaxRatePercent: Number(shippingTaxRate) || 0,
          withholdingMode: withholdingMode as "NONE" | "TDS" | "TCS",
          withholdingRatePercent: Number(withholdingRate) || 0,
          adjustment: Number(adjustment) || 0,
          roundOff: roundOffTotals,
        },
      ),
    [lines, supplyType, shippingCharge, shippingTaxRate, withholdingMode, withholdingRate, adjustment, roundOffTotals],
  );

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function applyCatalogItem(key: string, item: CatalogItem) {
    updateLine(key, {
      itemId: item.id,
      name: item.name,
      // The catalogue's own description seeds the line, and stays editable — a quote often needs
      // to say something about this sale that the catalogue can't know.
      description: item.description ?? "",
      hsnCode: item.hsnCode ?? "",
      unit: item.unit ?? "",
      // Converted, not copied. The catalogue is priced in rupees; dropping ₹72,500 straight into
      // a dollar quote makes it $72,500, which is the single most expensive mistake this form
      // could make and looks entirely normal on the way past.
      unitPrice: String(catalogPriceInDocumentCurrency(item.sellingPrice ?? 0)),
      taxRatePercent: String(item.taxRatePercent ?? 0),
    });
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);

    const payload = {
      ...(defaults.id ? { id: defaults.id } : {}),
      docType,
      docNumber,
      companyId,
      locationId,
      placeOfSupplyCode,
      gstTreatment,
      // The party's GSTIN, whichever side they are on — the payload keeps its historical name.
      buyerGstin,
      reverseCharge,
      // Blank where there was no choice to make: with one branch, or a credit note following its
      // invoice, the server applies the same answer itself.
      branchId: branches.length > 1 && !followsInvoice ? branchId : "",
      currency,
      // Forced back to 1 on a rupee document rather than left at whatever was typed before
      // somebody switched back — the schema refuses the mismatch, and failing validation on a
      // field they have already hidden would be a dead end.
      exchangeRate: isBaseCurrency(currency) ? 1 : Number(exchangeRate) || 1,
      issueDate,
      dueDate,
      validUntil,
      reference,
      salespersonId,
      notes,
      terms,
      dispatchFromAddress: dispatchFrom,
      billing,
      shippingSameAsBilling: shippingSame,
      shipping: shippingSame ? billing : shipping,
      shippingGstin,
      shippingCharge,
      shippingTaxRatePercent: shippingTaxRate,
      withholdingMode,
      withholdingSection,
      withholdingRatePercent: withholdingRate,
      adjustmentLabel,
      adjustment,
      sourceDocumentId: defaults.sourceDocumentId,
      // No control for this one: the deal is decided by where the form was opened from, and a
      // picker would only invite someone to attribute an invoice to the wrong lead.
      leadId: defaults.leadId,
      againstDocumentId,
      lines: lines.map((l) => ({
        itemId: l.itemId,
        name: l.name,
        description: l.description,
        hsnCode: l.hsnCode,
        unit: l.unit,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountMode: l.discountMode,
        discountValue: l.discountValue,
        taxRatePercent: l.taxRatePercent,
      })),
    };

    startTransition(async () => {
      const result = defaults.id ? await updateTradeDocument(payload) : await createTradeDocument(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/documents/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="animate-fade-rise space-y-5">
      {/* Here rather than on the page, so it follows the branch chosen below. */}
      {selectedBranch && !sellerStateCode && (
        <Card className="border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
          {branches.length > 1
            ? `${branchLabel(selectedBranch)} has no GSTIN or state set, so its documents will be taxed as inter-state (IGST).`
            : "Your organisation's GSTIN and state aren't set, so every document will be taxed as inter-state (IGST)."}{" "}
          Set your GSTIN under Settings → Organisation (head office) or Settings → Branches &amp; GST registrations.
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">
          {isSales ? "Customer" : "Vendor"} &amp; addresses
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="companyId">
                {isSales ? "Customer name" : "Vendor name"} <span className="text-danger">*</span>
              </Label>
              <CompanyCombobox
                id="companyId"
                companies={parties.map((p) => ({
                  ...p,
                  hint: p.relationshipType === "RESELLER" ? "(reseller)" : undefined,
                }))}
                value={companyId}
                onSelect={(company) => {
                  setCompanyId(company?.id ?? "");
                  setBillingTouched(false);
                }}
                disabled={!!defaults.id}
                placeholder={isSales ? "Type to search customers…" : "Type to search vendors…"}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="locationId">Location on file</Label>
              <Select
                id="locationId"
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setBillingTouched(false);
                  adoptLocation(locations.find((l) => l.id === e.target.value) ?? null);
                }}
              >
                <option value="">No location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                    {l.city ? ` — ${l.city}` : ""}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">Fills the billing address and GST details below.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="placeOfSupplyCode">
                Place of supply <span className="text-danger">*</span>
              </Label>
              <Select
                id="placeOfSupplyCode"
                value={placeOfSupplyCode}
                onChange={(e) => {
                  setPlaceTouched(true);
                  setPlaceOverride(e.target.value);
                }}
              >
                <option value="">Not set</option>
                {GST_STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    [{s.code}] {s.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-subtle">
                {supplyType === "INTRA_STATE" ? "Intra-state — CGST + SGST" : "Inter-state — IGST"}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-5 border-t border-line pt-4 sm:grid-cols-3">
            <div className="space-y-1">
              {/* The caption is a styled `<span>`, not a `<label>`, so `aria-labelledby` points at it
                  rather than pairing it — that leaves the wording in one place and the styling alone. */}
              <span id={`${fieldId}-dispatch-from`} className="text-xs uppercase tracking-wide text-subtle">
                Dispatch from
              </span>
              <Textarea
                rows={4}
                value={dispatchFrom}
                onChange={(e) => setDispatchFrom(e.target.value)}
                placeholder="Where the goods leave from"
                aria-labelledby={`${fieldId}-dispatch-from`}
                className="text-sm"
              />
            </div>

            <AddressEditor
              title="Billing address"
              value={billing}
              onChange={(next) => {
                setBillingTouched(true);
                setBilling(next);
                if (shippingSame) setShipping(next);
              }}
              emptyText="Pick a location, or add one here."
            />

            <AddressEditor
              title="Shipping address"
              value={shippingSame ? billing : shipping}
              onChange={(next) => {
                setShippingSame(false);
                setShipping(next);
              }}
              disabled={shippingSame}
              emptyText="Same as billing."
              action={
                <label className="flex items-center gap-1.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={shippingSame}
                    onChange={(e) => {
                      setShippingSame(e.target.checked);
                      if (e.target.checked) setShipping(billing);
                    }}
                    className="h-3.5 w-3.5 accent-[var(--brand)]"
                  />
                  Same as billing
                </label>
              }
            />
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="currency">Currency</Label>
              <Select
                id="currency"
                value={currency}
                onChange={(e) => {
                  const next = e.target.value;
                  setCurrency(next);
                  if (isBaseCurrency(next)) {
                    // Back to rupees: the rate must go back to 1 or the schema refuses the save,
                    // and leaving a stale 83.25 behind a hidden field is how that happens.
                    setExchangeRate("1");
                    setRateTouched(false);
                    setRateNote(null);
                    return;
                  }
                  fetchRate(next, issueDate, true);
                }}
              >
                {CURRENCIES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.label}
                  </option>
                ))}
              </Select>
            </div>

            {/* Only when it is needed. A rate field on every rupee document is a field nobody
                fills in and one person eventually gets wrong. */}
            {!isBaseCurrency(currency) && (
              <div className="space-y-1.5">
                <Label htmlFor="exchangeRate">Exchange rate</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="exchangeRate"
                    type="number"
                    step="0.0001"
                    min="0"
                    value={exchangeRate}
                    onChange={(e) => {
                      setRateTouched(true);
                      setRateNote(null);
                      setExchangeRate(e.target.value);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => fetchRate(currency, issueDate, true)}
                    disabled={rateLoading}
                    className="shrink-0 text-xs text-brand hover:underline disabled:opacity-50"
                  >
                    {rateLoading ? "Looking up…" : "Use the day's rate"}
                  </button>
                </div>
                <p className="text-xs text-subtle">
                  {rateHint(currency, Number(exchangeRate) || 0)} · the ledger posts the rupee equivalent at this
                  rate.{rateNote ? ` ${rateNote}.` : ""}
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="gstTreatment">GST treatment</Label>
              <Select
                id="gstTreatment"
                value={gstTreatment}
                onChange={(e) => {
                  setGstTreatment(e.target.value);
                  // An unregistered party has no GSTIN to carry, so clearing it avoids printing a
                  // stale number on a document that shouldn't have one.
                  if (!registeredTreatments.includes(e.target.value as (typeof registeredTreatments)[number])) {
                    setBuyerGstin("");
                  }
                }}
              >
                {gstTreatmentValues.map((t) => (
                  <option key={t} value={t}>
                    {gstTreatmentLabels[t]}
                  </option>
                ))}
              </Select>
            </div>

            {gstinRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="buyerGstin">
                  GSTIN <span className="text-danger">*</span>
                </Label>
                <Input
                  id="buyerGstin"
                  value={buyerGstin}
                  onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())}
                  placeholder="27AABCW1234F1ZV"
                  className="font-mono"
                />
              </div>
            )}

            {!shippingSame && gstinRequired && (
              <div className="space-y-1.5">
                <Label htmlFor="shippingGstin">Shipping GSTIN</Label>
                <Input
                  id="shippingGstin"
                  value={shippingGstin}
                  onChange={(e) => setShippingGstin(e.target.value.toUpperCase())}
                  className="font-mono"
                />
              </div>
            )}

            <label className="flex items-center gap-2 self-end pb-2 text-sm text-text">
              <input
                type="checkbox"
                checked={reverseCharge}
                onChange={(e) => setReverseCharge(e.target.checked)}
                className="h-4 w-4 accent-[var(--brand)]"
              />
              Reverse charge applies
            </label>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Document details</CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* Only when there is a choice: a single-branch company sees the form it always had. */}
          {branches.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="branchId">{isSales ? "Branch" : "Buying branch"}</Label>
              <Select id="branchId" value={branchId} onChange={(e) => chooseBranch(e.target.value)} disabled={followsInvoice}>
                {/* The invoice's branch, since deactivated, is not among the choices — but it is the answer. */}
                {!selectedBranch && <option value={branchId}>The invoice&apos;s branch (inactive)</option>}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {branchLabel(b)}
                    {b.active ? "" : " (inactive)"}
                    {gstNumbered && !b.canIssueTaxDocuments ? " — can't issue tax invoices" : ""}
                  </option>
                ))}
              </Select>
              {followsInvoice ? (
                <p className="text-xs text-subtle">Follows the invoice.</p>
              ) : selectedBranch && !selectedBranch.active ? (
                <p className="text-xs text-warning">This branch is inactive: the draft can be saved, but move it to an active branch to issue it.</p>
              ) : gstNumbered && selectedBranch && !selectedBranch.canIssueTaxDocuments ? (
                <p className="text-xs text-subtle">
                  No GST registration here, so it can&apos;t issue a {tradeDocumentLabels[docType].toLowerCase()}. Save the draft, or
                  choose a branch with a GSTIN.
                </p>
              ) : null}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="docNumber">
              {tradeDocumentLabels[docType]} # <span className="text-danger">*</span>
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="docNumber"
                value={docNumber}
                onChange={(e) => setDocNumber(e.target.value)}
                placeholder={numberMode === "MANUAL" ? "Type the number" : "Auto"}
                className="font-mono"
                required
              />
              <NumberSettingsDialog
                docType={docType}
                setting={series.setting}
                branchId={branchId || null}
                onApplied={(generated, mode) => {
                  setNumberMode(mode);
                  if (mode === "AUTO" && generated) {
                    setDocNumber(generated);
                    setGeneratedNumber(generated);
                  }
                  if (mode === "MANUAL") {
                    setDocNumber("");
                    setGeneratedNumber(null);
                  }
                  // The gear saved this branch's series: read it back, so the next visit starts from it.
                  followSeries(branchId, false);
                }}
              />
            </div>
            {numberLoading ? (
              <p className="text-xs text-subtle">Checking this branch&apos;s numbering…</p>
            ) : renumbering ? (
              <p className="text-xs text-subtle">
                Saving renumbers this draft from the series for {series.setting.ownerLabel ?? (selectedBranch ? branchLabel(selectedBranch) : "this branch")}
                {series.preview ? ` (next: ${series.preview})` : ""}; {defaults.docNumber} is left as a gap.
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="issueDate">
              Date <span className="text-danger">*</span>
            </Label>
            <Input id="issueDate" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} required />
          </div>

          {docType === "PROPOSAL" ? (
            <div className="space-y-1.5">
              <Label htmlFor="validUntil">Expiry date</Label>
              <Input id="validUntil" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="dueDate">Due date</Label>
              <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="reference">Reference # / their PO</Label>
            <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="PO-2026-118" />
          </div>

          {isSales && (
            <div className="space-y-1.5">
              <Label htmlFor="salespersonId">Salesperson</Label>
              <Select id="salespersonId" value={salespersonId} onChange={(e) => setSalespersonId(e.target.value)}>
                <option value="">Account owner</option>
                {salespeople.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </Select>
              {/* Shown rather than left to be looked up: this is the contact the customer will
                  be given, and a wrong one is only discovered when they fail to get through. */}
              {chosenSalesperson && (chosenSalesperson.email || chosenSalesperson.phone) && (
                <p className="text-xs text-subtle">
                  {[chosenSalesperson.email, chosenSalesperson.phone].filter(Boolean).join(" · ")}
                </p>
              )}
              {chosenSalesperson && !chosenSalesperson.phone && (
                <p className="text-xs text-subtle">No work phone on file for them.</p>
              )}
            </div>
          )}

          {isCreditNote && (
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="againstDocumentId">
                Against invoice <span className="text-danger">*</span>
              </Label>
              <Select
                id="againstDocumentId"
                value={againstDocumentId}
                onChange={(e) => {
                  setAgainstDocumentId(e.target.value);
                  // The credit note moves to the invoice's branch — its GSTIN, its series, its address.
                  const invoice = creditable.find((inv) => inv.id === e.target.value);
                  if (invoice) chooseBranch(invoice.branchId ?? headOfficeId);
                }}
                required
              >
                <option value="">Select the invoice this reduces…</option>
                {creditable.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.docNumber} — {money(inv.total)}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
          <span>Item table</span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setLines((prev) => [...prev, blankLine()])}>
            <Plus className="h-3.5 w-3.5" /> Add new row
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Item details</th>
                  <th className="w-24 px-3 py-2">HSN/SAC</th>
                  <th className="w-20 px-3 py-2 text-right">Quantity</th>
                  <th className="w-28 px-3 py-2 text-right">Rate</th>
                  <th className="w-36 px-3 py-2">Discount</th>
                  <th className="w-28 px-3 py-2">Tax</th>
                  <th className="w-32 px-3 py-2 text-right">Amount</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key} className="border-b border-line align-top last:border-0">
                    <td className="px-3 py-2">
                      <ItemPicker
                        value={line.name}
                        unit={line.unit}
                        description={line.description}
                        lineNumber={index + 1}
                        onNameChange={(value) => updateLine(line.key, { name: value, itemId: "" })}
                        onDescriptionChange={(value) => updateLine(line.key, { description: value })}
                        onUnitChange={(value) => updateLine(line.key, { unit: value })}
                        onPick={(item) => applyCatalogItem(line.key, item)}
                        converted={(rupees) =>
                          isBaseCurrency(currency) ? null : money(catalogPriceInDocumentCurrency(rupees))
                        }
                      />
                    </td>
                    <td className="px-3 py-2">
                      {/* Named per row: the column header says "HSN", and in a grid of eleven
                          identical boxes that is not enough to say which one you are in. */}
                      <Input
                        aria-label={`HSN code, line ${index + 1}`}
                        value={line.hsnCode}
                        onChange={(e) => updateLine(line.key, { hsnCode: e.target.value })}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        step="0.001"
                        min="0"
                        aria-label={`Quantity, line ${index + 1}`}
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        className="text-right"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        aria-label={`Rate, line ${index + 1}`}
                        value={line.unitPrice}
                        onChange={(e) => updateLine(line.key, { unitPrice: e.target.value })}
                        className="text-right"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          aria-label={`Discount, line ${index + 1}`}
                          value={line.discountValue}
                          onChange={(e) => updateLine(line.key, { discountValue: e.target.value })}
                          className="text-right"
                        />
                        <Select
                          value={line.discountMode}
                          onChange={(e) => updateLine(line.key, { discountMode: e.target.value })}
                          className="w-16 shrink-0"
                          aria-label="Discount type"
                        >
                          <option value="PERCENT">%</option>
                          <option value="AMOUNT">{symbol}</option>
                        </Select>
                      </div>
                      {(totals.lines[index]?.discountAmount ?? 0) > 0 && (
                        <div className="mt-0.5 text-xs text-subtle">
                          − {money(totals.lines[index].discountAmount)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Select
                        value={line.taxRatePercent}
                        onChange={(e) => updateLine(line.key, { taxRatePercent: e.target.value })}
                        aria-label="Tax rate"
                      >
                        {GST_RATES.map((rate) => (
                          <option key={rate} value={rate}>
                            GST {rate}%
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="font-medium text-text">{money(totals.lines[index]?.lineTotal ?? 0)}</div>
                      <div className="text-xs text-subtle">
                        {money(totals.lines[index]?.taxableValue ?? 0)} + tax
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove line"
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader className="text-sm font-medium text-text">Notes &amp; terms</CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="notes">Customer notes</Label>
              <Textarea id="notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="terms">Terms &amp; conditions</Label>
              <Textarea id="terms" rows={4} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="text-sm font-medium text-text">Summary</CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Sub total" value={money(totals.subtotal)} />
            {totals.discountTotal > 0 && <Row label="Discount" value={`− ${money(totals.discountTotal)}`} />}

            <div className="flex items-center justify-between gap-3 text-muted">
              <span>Shipping charges</span>
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={shippingCharge}
                  onChange={(e) => setShippingCharge(e.target.value)}
                  placeholder="0.00"
                  className="h-8 w-28 text-right"
                  aria-label="Shipping charges"
                />
                <Select
                  value={shippingTaxRate}
                  onChange={(e) => setShippingTaxRate(e.target.value)}
                  className="h-8 w-24"
                  aria-label="Shipping tax rate"
                >
                  {["0", "5", "12", "18", "28"].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}%
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            <Row label="Taxable value" value={money(totals.taxableValue)} />
            {supplyType === "INTRA_STATE" ? (
              <>
                <Row label="CGST" value={money(totals.cgstAmount)} />
                <Row label="SGST" value={money(totals.sgstAmount)} />
              </>
            ) : (
              <Row label="IGST" value={money(totals.igstAmount)} />
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 text-muted">
              <div className="flex items-center gap-3">
                {(["NONE", "TDS", "TCS"] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="radio"
                      checked={withholdingMode === mode}
                      onChange={() => setWithholdingMode(mode)}
                      className="h-3.5 w-3.5 accent-[var(--brand)]"
                    />
                    {mode === "NONE" ? "No TDS/TCS" : mode}
                  </label>
                ))}
              </div>
              <span className={totals.withholdingAmount < 0 ? "text-danger" : "text-text"}>
                {totals.withholdingAmount === 0
                  ? money(0)
                  : `${totals.withholdingAmount < 0 ? "− " : "+ "}${money(Math.abs(totals.withholdingAmount))}`}
              </span>
            </div>

            {withholdingMode !== "NONE" && (
              <div className="flex items-center gap-2 pl-1">
                <Input
                  value={withholdingSection}
                  onChange={(e) => setWithholdingSection(e.target.value)}
                  placeholder="Section (194Q)"
                  className="h-8 w-36"
                  aria-label="TDS/TCS section"
                />
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={withholdingRate}
                  onChange={(e) => setWithholdingRate(e.target.value)}
                  placeholder="Rate"
                  className="h-8 w-20 text-right"
                  aria-label="TDS/TCS rate"
                />
                <span className="text-xs text-subtle">% of taxable value</span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 text-muted">
              <Input
                value={adjustmentLabel}
                onChange={(e) => setAdjustmentLabel(e.target.value)}
                className="h-8 w-32"
                aria-label="Adjustment label"
              />
              <Input
                type="number"
                step="0.01"
                value={adjustment}
                onChange={(e) => setAdjustment(e.target.value)}
                placeholder="0.00"
                className="h-8 w-28 text-right"
                aria-label="Adjustment amount"
              />
            </div>

            {totals.roundOff !== 0 && <Row label="Round off" value={money(totals.roundOff)} />}

            <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-text">
              <span>Total ({currency})</span>
              <span>{money(totals.total)}</span>
            </div>
            {reverseCharge && (
              <Badge tone="amber" className="mt-2">
                Tax payable under reverse charge
              </Badge>
            )}
          </CardContent>
        </Card>
      </div>

      {error && (
        <div className="rounded-base border border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</div>
      )}

      <div className="flex items-center gap-3">
        {/* Held while a branch change is fetching its number, so the old branch's number isn't saved under the new one. */}
        <Button type="submit" disabled={pending || !companyId || numberLoading}>
          {pending ? "Saving…" : defaults.id ? "Save changes" : `Save ${tradeDocumentLabels[docType].toLowerCase()}`}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => router.push(defaults.id ? `/documents/${defaults.id}` : documentListPath[docType])}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-muted">
      <span>{label}</span>
      <span className="text-text">{value}</span>
    </div>
  );
}

/**
 * Free text with a catalogue lookup behind it. A document line is often a one-off ("AMC — 3 site
 * visits") that isn't a SKU, so the description is always typeable and picking an item is a
 * shortcut that fills in price, tax, HSN and unit rather than a requirement.
 */
function ItemPicker({
  value,
  unit,
  description,
  lineNumber,
  onNameChange,
  onDescriptionChange,
  onUnitChange,
  onPick,
  converted,
}: {
  value: string;
  /** Which row this is, so its three fields can say so out loud. */
  lineNumber: number;
  unit: string;
  description: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onUnitChange: (value: string) => void;
  onPick: (item: CatalogItem) => void;
  /**
   * What a rupee catalogue price becomes on this document, already formatted.
   *
   * Passed in rather than computed here because the currency and the rate belong to the form,
   * and a picker that reached for them would be a second place that has to know the conversion.
   * Absent on a rupee document, where there is nothing to convert.
   */
  converted?: (rupees: number) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogItem[]>([]);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      listDocumentItems(query || undefined).then((rows) => {
        if (!cancelled) setResults(rows);
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  // The panel is portalled out of the table, so a click elsewhere no longer counts as a blur —
  // closing it has to be handled explicitly.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (anchorRef.current?.contains(target)) return;
      if (target.closest?.("[data-item-picker-panel]")) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={anchorRef} className="space-y-1.5">
      <div className="flex gap-1.5">
        <Input
          aria-label={`Item, line ${lineNumber}`}
          value={value}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Type or click to select an item"
        />
        <Button type="button" variant="secondary" size="icon" aria-label="Find item" onClick={() => setOpen((o) => !o)}>
          <Search className="h-4 w-4" />
        </Button>
      </div>
      <Textarea
        aria-label={`Description, line ${lineNumber}`}
        value={description}
        onChange={(e) => onDescriptionChange(e.target.value)}
        placeholder="Description — what's included, the period covered, serial numbers…"
        rows={2}
        className="text-xs"
      />
      <Input
        aria-label={`Unit, line ${lineNumber}`}
        value={unit}
        onChange={(e) => onUnitChange(e.target.value)}
        placeholder="Unit (NOS, PCS…)"
        className="h-8 w-32 text-xs"
      />

      <AnchoredPopover anchorRef={anchorRef} open={open} width={420} maxHeight={340}>
        <div data-item-picker-panel className="p-2">
          <Input
            aria-label="Search the catalogue"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the catalogue…"
          />
          <div className="mt-2">
            {results.map((item) => (
              <button
                key={item.id}
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-base px-2 py-1.5 text-left text-sm hover:bg-surface-sunken"
                onClick={() => {
                  onPick(item);
                  setOpen(false);
                }}
              >
                <span className="min-w-0">
                  <span className="block truncate text-text">{item.name}</span>
                  <span className="block truncate text-xs text-subtle">{item.sku}</span>
                </span>
                {/* The catalogue's own rupee price. On a foreign-currency document the line is
                    added at the converted figure, so this is shown for what it is. */}
                <span className="shrink-0 text-xs text-muted">
                  {formatCurrency(item.sellingPrice)}
                  {converted?.(item.sellingPrice ?? 0) && (
                    <span className="ml-1 text-subtle">→ {converted(item.sellingPrice ?? 0)}</span>
                  )}
                </span>
              </button>
            ))}
            {results.length === 0 && <p className="px-2 py-3 text-sm text-subtle">No matching items.</p>}
          </div>
        </div>
      </AnchoredPopover>
    </div>
  );
}
