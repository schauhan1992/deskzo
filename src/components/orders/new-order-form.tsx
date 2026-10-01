"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { createOrderSchema, type CreateOrderInput } from "@/lib/validation/order";
import { createOrder } from "@/actions/order";
import { punchCustomerContext, punchItemContext, type PunchCustomerContext, type PunchItemContext } from "@/actions/order-punch";
import { formatOrderId } from "@/lib/order-id";
import { Card } from "@/components/ui/card";
import type { CompanyComboOption } from "@/components/ui/company-combobox";
import type { ItemComboOption } from "@/components/items/item-combobox";
import { CustomerSection } from "./punch/customer-section";
import { ProductSection } from "./punch/product-section";
import { TermsSection } from "./punch/terms-section";
import { CostFold } from "./punch/cost-fold";
import { RebateFold } from "./punch/rebate-fold";
import { ExtrasFold } from "./punch/extras-fold";
import { NotesFold } from "./punch/notes-fold";
import { OrderSummary, PunchBar } from "./punch/order-summary";
import {
  firstErrorField,
  foldsWithErrors,
  type CommissionPartyOption,
  type CustomerContext,
  type EndCustomerOption,
  type FoldKey,
  type LocationOption,
  type ProposalOption,
  type PunchErrors,
  type PunchFormValues,
} from "./punch/types";

/** A lookup's answer with what it was asked for, so an answer to an earlier question is never shown for the current one. */
type Loaded<T> = { key: string; value: T | null; failed: boolean };
const NOTHING_LOADED: Loaded<never> = { key: "", value: null, failed: false };

/** Every field blank, as a new order starts. */
function blankValues(): PunchFormValues {
  return {
    companyId: "",
    locationId: "",
    itemId: "",
    quantity: 1,
    unitPrice: "",
    businessType: "NEW",
    endCustomerId: "",
    poNumber: "",
    proposalId: "",
    paymentTerms: "",
    creditOverrideReason: "",
    startDate: "",
    endDate: "",
    notes: "",
    watcherUserIds: [],
    expenses: [],
    // Sent now is what every order always did, so it stays the default.
    handoff: "NOW",
    releaseOn: "",
    quotedPurchasePrice: "",
    quoteVendorId: "",
    quoteVendorName: "",
    quoteContact: "",
    quotedOn: "",
    quoteRemarks: "",
    dealRegStatus: "",
    dealRegNumber: "",
    dealRegValidTo: "",
    dealPrice: "",
    rebates: [],
  };
}

/**
 * The next order after "Punch and add another": the same customer, office, reference, terms, hand-off
 * and watchers — a deal of three products is three orders — and everything about the product fresh.
 */
function nextOrderValues(current: PunchFormValues): PunchFormValues {
  return {
    ...blankValues(),
    companyId: current.companyId,
    locationId: current.locationId,
    endCustomerId: current.endCustomerId,
    poNumber: current.poNumber,
    proposalId: current.proposalId,
    paymentTerms: current.paymentTerms,
    creditOverrideReason: current.creditOverrideReason,
    handoff: current.handoff,
    releaseOn: current.releaseOn,
    watcherUserIds: current.watcherUserIds ?? [],
  };
}

/** The office an order goes to unless somebody picks another: the primary, else the first. */
function primaryLocationOf(context: CustomerContext): string {
  return context.locations.find((l) => l.isPrimary)?.id ?? context.locations[0]?.id ?? "";
}

/**
 * The order-punching form.
 *
 * Sections on the left — customer, product and price, terms and hand-off, then the optional parts
 * folded — and the order summary on the right, sticky on a wide screen. Each section subscribes only to
 * the fields it shows (`useWatch`), so typing a price re-renders the figures and not the whole form.
 *
 * Choosing a customer asks the server one question (`punchCustomerContext`: offices, proposals, end
 * customers, linked commission parties, credit), and choosing a product another (`punchItemContext`:
 * renewal or new, a reseller's price). Next runs a client's server actions one after another, so these
 * replace the five and two lookups the form used to queue. Each answer is kept with the question it
 * answers, and shown only while that is still the question.
 */
export function NewOrderForm({
  companies,
  items,
  users,
  commissionParties = [],
  vendors = [],
  initialCompanyId,
  initialContext = null,
  customerSearch = false,
  itemSearch = false,
  creditInPlan = false,
  resellersInPlan = false,
  canSeeRebates = false,
  initialLocations,
  initialProposals,
  initialEndCustomers,
}: {
  /** The first page of the customer book, with the prefilled customer in it. */
  companies: CompanyComboOption[];
  /** The first page of the catalogue. */
  items: ItemComboOption[];
  /** Who can be added as a watcher. */
  users: { id: string; name: string; role?: string }[];
  commissionParties?: CommissionPartyOption[];
  /** The vendors a distributor price can name — or it is typed, for one not in the CRM. */
  vendors?: { id: string; name: string }[];
  initialCompanyId?: string;
  /** What `punchCustomerContext` says about `initialCompanyId`, looked up with the page. */
  initialContext?: PunchCustomerContext | null;
  /** `companies` is not the whole book: two typed characters search the server. */
  customerSearch?: boolean;
  /** `items` is not the whole catalogue: two typed characters search the server. */
  itemSearch?: boolean;
  /** Receivables are in the workspace's plan: the customer's credit is shown as they are chosen. */
  creditInPlan?: boolean;
  /** Resellers are: a reseller's own price is filled in for them. */
  resellersInPlan?: boolean;
  /** Holds `rebates.view`: the backend rebate can be entered (owner: managers see rebates, executives don't). */
  canSeeRebates?: boolean;
  /** The prefilled customer's offices, from before `initialContext` — still taken from a caller that sends them. */
  initialLocations?: LocationOption[];
  initialProposals?: ProposalOption[];
  initialEndCustomers?: EndCustomerOption[];
}) {
  const router = useRouter();

  const [customer, setCustomer] = useState<Loaded<CustomerContext>>(() => {
    if (!initialCompanyId) return NOTHING_LOADED;
    if (initialContext) return { key: initialCompanyId, value: initialContext, failed: false };
    if (initialLocations || initialProposals || initialEndCustomers) {
      const value: CustomerContext = {
        locations: initialLocations ?? [],
        proposals: initialProposals ?? [],
        endCustomers: initialEndCustomers ?? [],
        linkedPartyIds: commissionParties.filter((p) => p.linked).map((p) => p.id),
        credit: null,
      };
      return { key: initialCompanyId, value, failed: false };
    }
    // Nothing came with the page: looked up once the form is on screen, as for a customer chosen there.
    return NOTHING_LOADED;
  });

  const form = useForm<PunchFormValues, unknown, CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    // A failed submit focuses its first error itself, in page order — see `onInvalid`.
    shouldFocusError: false,
    defaultValues: {
      ...blankValues(),
      companyId: initialCompanyId ?? "",
      locationId: customer.value ? primaryLocationOf(customer.value) : "",
    },
  });
  const {
    control,
    handleSubmit,
    reset,
    getValues,
    setValue,
    setFocus,
    getFieldState,
    formState: { errors, isSubmitting },
  } = form;
  const [companyId = "", itemId = ""] = useWatch({ control, name: ["companyId", "itemId"] });

  // The option objects the pickers handed over. A search result is not in `companies` or `items`, so
  // the chosen one is kept rather than looked up again.
  const [pickedCompany, setPickedCompany] = useState<CompanyComboOption | null>(null);
  const [pickedItem, setPickedItem] = useState<ItemComboOption | null>(null);
  const selectedCompany = companyId
    ? pickedCompany?.id === companyId
      ? pickedCompany
      : companies.find((c) => c.id === companyId)
    : undefined;
  const selectedItem = (itemId ? (pickedItem?.id === itemId ? pickedItem : items.find((i) => i.id === itemId)) : undefined) ?? null;

  // ── The customer's context ──────────────────────────────────────────────────────────────────────

  const context = companyId && customer.key === companyId ? customer.value : null;
  const contextLoading = !!companyId && customer.key !== companyId;
  const contextFailed = !!companyId && customer.key === companyId && customer.failed;
  const credit = creditInPlan ? (context?.credit ?? null) : null;

  /** Sets the office, re-checking it only if it is already showing an error. */
  function chooseLocation(id: string) {
    setValue("locationId", id, { shouldValidate: !!getFieldState("locationId").error });
  }

  const receiveCustomer = useEffectEvent((id: string, value: CustomerContext | null) => {
    setCustomer({ key: id, value, failed: value === null });
    // The primary office is chosen as the offices arrive, unless somebody has already picked one.
    if (value && !getValues("locationId")) chooseLocation(primaryLocationOf(value));
  });
  useEffect(() => {
    if (!companyId || customer.key === companyId) return;
    let cancelled = false;
    punchCustomerContext(companyId)
      .then((value) => {
        if (!cancelled) receiveCustomer(companyId, value);
      })
      .catch(() => {
        if (!cancelled) receiveCustomer(companyId, null);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, customer.key]);

  // ── The product's context ───────────────────────────────────────────────────────────────────────

  const itemKey = companyId && itemId ? `${companyId}|${itemId}` : "";
  const [itemInfo, setItemInfo] = useState<Loaded<PunchItemContext>>(NOTHING_LOADED);
  const itemContext = itemKey && itemInfo.key === itemKey ? itemInfo.value : null;
  const resellerPrice = resellersInPlan ? (itemContext?.resellerPrice ?? null) : null;
  // Once somebody picks new or renewal themselves, the detection never overrides them.
  const [typeChosen, setTypeChosen] = useState(false);
  const detectedType = itemContext && !typeChosen ? (itemContext.hasExistingOrder ? "RENEWAL" : "NEW") : null;

  /**
   * The reseller price this form typed into the price box, if it typed one. A reseller's price comes
   * from their own deal, not the catalogue, and is filled in so nobody quietly bills a partner at list
   * price — but only over a blank box or a price it filled itself, and it is taken out again when the
   * customer or product changes, so it never stays behind for a customer it was not meant for.
   */
  const autoPriceRef = useRef<number | null>(null);
  function dropAutoPrice() {
    const auto = autoPriceRef.current;
    autoPriceRef.current = null;
    if (auto !== null && Number(getValues("unitPrice")) === auto) setValue("unitPrice", "");
  }

  const receiveItem = useEffectEvent((key: string, info: PunchItemContext | null) => {
    setItemInfo({ key, value: info, failed: info === null });
    if (!info) {
      // No answer: the order is new business, as it is while the question is out (see `changeItem`).
      if (!typeChosen) setValue("businessType", "NEW");
      return;
    }
    // A customer who already has this product, on an order that went ahead, is most likely renewing.
    // Nobody but the salesperson knows whether they had it elsewhere before, so that stays theirs to say.
    if (!typeChosen) setValue("businessType", info.hasExistingOrder ? "RENEWAL" : "NEW");
    const price = resellersInPlan ? info.resellerPrice : null;
    if (!price) {
      dropAutoPrice();
      return;
    }
    const current = getValues("unitPrice");
    const blank = current === "" || current === undefined || current === null;
    if (blank || (autoPriceRef.current !== null && Number(current) === autoPriceRef.current)) {
      setValue("unitPrice", price.unitPrice);
      autoPriceRef.current = price.unitPrice;
    }
  });
  useEffect(() => {
    if (!companyId || !itemId) return;
    const key = `${companyId}|${itemId}`;
    let cancelled = false;
    punchItemContext({ companyId, itemId })
      .then((info) => {
        if (!cancelled) receiveItem(key, info);
      })
      // Without an answer the order is treated as new at the catalogue price, which can still be changed by hand.
      .catch(() => {
        if (!cancelled) receiveItem(key, null);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, itemId]);

  // ── Choosing ────────────────────────────────────────────────────────────────────────────────────

  function changeCustomer(company: CompanyComboOption | null) {
    setPickedCompany(company);
    if (company && company.id === companyId) {
      // The customer already chosen, picked again from the list: nothing about the order changes —
      // unless their details failed to load, when picking them again is how the lookup is retried.
      if (contextFailed) setCustomer(NOTHING_LOADED);
      return;
    }
    // The previous customer's proposal and end customer can't apply to this one, nor a renewal worked
    // out from their orders: until the next answer the order reads as new, unless somebody chose.
    setValue("proposalId", "");
    setValue("endCustomerId", "");
    if (!typeChosen) setValue("businessType", "NEW");
    dropAutoPrice();
    // Typing over the name un-chooses the customer and leaves what was loaded for them, so choosing
    // them again needs no second lookup. A lookup that failed is asked again.
    const kept = company && customer.key === company.id && !customer.failed ? customer.value : null;
    chooseLocation(kept ? primaryLocationOf(kept) : "");
    if (company && !kept) setCustomer(NOTHING_LOADED);
  }

  function changeItem(item: ItemComboOption | null) {
    setPickedItem(item);
    if (item && item.id === itemId) return;
    // A renewal detected for the previous product says nothing about this one. Until `punchItemContext`
    // answers — and it can wait behind other lookups — the order reads as new, unless somebody chose.
    if (!typeChosen) setValue("businessType", "NEW");
    dropAutoPrice();
  }

  // ── Folded sections ─────────────────────────────────────────────────────────────────────────────

  // Open or shut as the person left each one; until they touch it, a section opens when it holds something.
  const [folds, setFolds] = useState<Partial<Record<FoldKey, boolean>>>({});
  const foldChange = (key: FoldKey) => (open: boolean) => setFolds((prev) => (prev[key] === open ? prev : { ...prev, [key]: open }));
  const failing = new Set(foldsWithErrors(errors));

  function onInvalid(found: PunchErrors) {
    const keys = foldsWithErrors(found);
    // A field inside a closed <details> can't take focus, so the sections holding errors open first,
    // synchronously, before the first error on the page is focused.
    if (keys.length > 0) {
      flushSync(() => setFolds((prev) => ({ ...prev, ...Object.fromEntries(keys.map((key) => [key, true])) })));
    }
    const first = firstErrorField(found);
    if (first) setFocus(first);
  }

  // ── Punching ────────────────────────────────────────────────────────────────────────────────────

  const [serverError, setServerError] = useState<string | null>(null);
  const [justPunched, setJustPunched] = useState<string | null>(null);
  // Set once the order is in and the page is on its way to it. `isSubmitting` ends as soon as the
  // action answers, and a second click before the order page arrives would punch the order twice.
  const [leaving, setLeaving] = useState(false);
  const busy = isSubmitting || leaving;

  async function punch(values: CreateOrderInput, another: boolean) {
    setServerError(null);
    setJustPunched(null);
    let result: Awaited<ReturnType<typeof createOrder>>;
    try {
      result = await createOrder(values);
    } catch {
      setServerError("The order didn't reach the server — check the connection and try again.");
      return;
    }
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    const ref = formatOrderId(result.data.orderSeq);
    if (!another) {
      setLeaving(true);
      router.push(`/orders/${ref}`);
      return;
    }
    reset(nextOrderValues(getValues()));
    setPickedItem(null);
    setTypeChosen(false);
    autoPriceRef.current = null;
    setFolds({});
    setJustPunched(ref);
  }

  // After "Punch and add another" the next product is what comes next, so its field is ready for it —
  // once the reset has rendered, since the reset drops react-hook-form's field refs until then.
  useEffect(() => {
    if (justPunched) setFocus("itemId");
  }, [justPunched, setFocus]);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    // Which button sent the form. Enter in a field sends it as the first one — the plain "Punch order".
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const another = submitter?.dataset.then === "another";
    void handleSubmit((values) => punch(values, another), onInvalid)(event);
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-6">
        <CustomerSection
          form={form}
          errors={errors}
          companies={companies}
          customerSearch={customerSearch}
          companyId={companyId}
          selectedCompany={selectedCompany}
          context={context}
          contextLoading={contextLoading}
          contextFailed={contextFailed}
          credit={credit}
          onCustomerChange={changeCustomer}
          onRetryContext={() => setCustomer(NOTHING_LOADED)}
        />
        <ProductSection
          form={form}
          errors={errors}
          items={items}
          itemSearch={itemSearch}
          selectedItem={selectedItem}
          resellerPrice={resellerPrice}
          detectedType={detectedType}
          onItemChange={changeItem}
          onTypeChosen={() => setTypeChosen(true)}
        />
        <TermsSection form={form} errors={errors} credit={credit} selectedItem={selectedItem} />
        <Card className="divide-y divide-line overflow-hidden">
          <CostFold
            form={form}
            errors={errors}
            vendors={vendors}
            selectedItem={selectedItem}
            open={folds.cost}
            hasError={failing.has("cost")}
            onOpenChange={foldChange("cost")}
          />
          {canSeeRebates && (
            <RebateFold
              form={form}
              errors={errors}
              vendors={vendors}
              selectedItem={selectedItem}
              open={folds.rebates}
              hasError={failing.has("rebates")}
              onOpenChange={foldChange("rebates")}
            />
          )}
          <ExtrasFold
            form={form}
            errors={errors}
            commissionParties={commissionParties}
            linkedPartyIds={context?.linkedPartyIds ?? []}
            users={users}
            open={folds.extras}
            hasError={failing.has("extras")}
            onOpenChange={foldChange("extras")}
          />
          <NotesFold
            form={form}
            proposals={context?.proposals ?? []}
            open={folds.notes}
            hasError={failing.has("notes")}
            onOpenChange={foldChange("notes")}
          />
        </Card>
        {/*
          In the sections' column rather than after the summary: a sticky grid item can only move within
          its own grid area, and a row of its own is exactly its height. Here it rides along the sections
          and comes to rest above the summary, which has the same buttons.
        */}
        <PunchBar form={form} selectedItem={selectedItem} busy={busy} submitting={isSubmitting} failed={!!serverError} />
      </div>

      <div className="lg:sticky lg:top-20 lg:self-start">
        <OrderSummary
          form={form}
          selectedItem={selectedItem}
          canSeeRebates={canSeeRebates}
          serverError={serverError}
          busy={busy}
          submitting={isSubmitting}
          justPunched={justPunched}
          onCancel={() => router.back()}
        />
      </div>
    </form>
  );
}
