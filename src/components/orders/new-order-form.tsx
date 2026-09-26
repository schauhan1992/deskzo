"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import {
  createOrderSchema,
  type CreateOrderInput,
  orderExpenseTypeValues,
  orderExpenseTypeLabels,
  orderBusinessTypeValues,
  orderBusinessTypeLabels,
} from "@/lib/validation/order";
import { createOrder, hasExistingOrderForItem } from "@/actions/order";
import { listCompanyLocationOptions } from "@/actions/company-location";
import { listProposalOptions } from "@/actions/order";
import { listCommissionPartyOptions, listEndCustomers } from "@/actions/company";
import { getResellerPriceForItem } from "@/actions/reseller";
import { resolveResellerPrice, describePriceSource } from "@/lib/reseller-pricing";
import { listCommissionPartyAccounts } from "@/actions/commission-party";
import { calculateOrderAmount, paymentTermsValues, paymentTermsLabels } from "@/lib/gst";
import { getCreditSnapshot } from "@/actions/credit";
import { CreditBadge } from "@/components/credit/credit-badge";
import { creditConcerns, termsExceed, type TermsKey } from "@/lib/credit/engine";
import { formatCurrency } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { ItemCombobox, type ItemComboOption } from "@/components/items/item-combobox";

type AssignableUser = { id: string; name: string; role: string };
type LocationOption = { id: string; label: string; isPrimary: boolean };
type ProposalOption = { id: string; status: string; validUntil: Date | string | null; lead: { title: string } };
type CommissionPartyOption = { id: string; name: string; linked?: boolean };
type EndCustomerOption = { id: string; name: string };
type CommissionPartyAccountOption = { id: string; label: string; isDefault: boolean };

type FormValues = z.input<typeof createOrderSchema>;

export function NewOrderForm({
  companies,
  items,
  users,
  commissionParties = [],
  initialCompanyId,
  initialLocations = [],
  initialProposals = [],
  initialEndCustomers = [],
  creditInPlan = true,
  resellersInPlan = true,
}: {
  /** Receivables are in the workspace's plan: the customer's credit is shown as they are chosen. */
  creditInPlan?: boolean;
  /** Resellers are: a reseller's own price is filled in for them. */
  resellersInPlan?: boolean;
  companies: CompanyComboOption[];
  items: ItemComboOption[];
  users: AssignableUser[];
  commissionParties?: CommissionPartyOption[];
  initialCompanyId?: string;
  initialLocations?: LocationOption[];
  initialProposals?: ProposalOption[];
  initialEndCustomers?: EndCustomerOption[];
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [locations, setLocations] = useState<LocationOption[]>(initialLocations);
  const [proposals, setProposals] = useState<ProposalOption[]>(initialProposals);
  const [commissionPartyOptions, setCommissionPartyOptions] = useState<CommissionPartyOption[]>(commissionParties);
  const [endCustomers, setEndCustomers] = useState<EndCustomerOption[]>(initialEndCustomers);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [accountsByParty, setAccountsByParty] = useState<Record<string, CommissionPartyAccountOption[]>>({});
  const fetchedPartyIdsRef = useRef<Set<string>>(new Set());
  const [, startCompanyTransition] = useTransition();
  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    defaultValues: {
      companyId: initialCompanyId ?? "",
      locationId: initialLocations.find((l) => l.isPrimary)?.id ?? initialLocations[0]?.id ?? "",
      quantity: 1,
      businessType: "NEW",
      watcherUserIds: [],
      expenses: [],
    },
  });
  const { fields: expenseFields, append: appendExpense, remove: removeExpense } = useFieldArray({ control, name: "expenses" });

  const selectedCompanyId = watch("companyId");
  const selectedCompany = companies.find((c) => c.id === selectedCompanyId);
  const isResellerCustomer = selectedCompany?.relationshipType === "RESELLER";
  const selectedItemId = watch("itemId");
  const selectedItem = items.find((i) => i.id === selectedItemId);
  const isSubscription = selectedItem?.type === "SUBSCRIPTION";
  const watcherUserIds = watch("watcherUserIds") ?? [];

  /**
   * The customer's credit, fetched when they are chosen — so the person punching the order sees
   * before saving what accounts will see at approval. Null when there is nothing to show (no
   * customer yet, or someone without the payments view), in which case the server still decides.
   */
  const [credit, setCredit] = useState<Awaited<ReturnType<typeof getCreditSnapshot>>>(null);
  useEffect(() => {
    if (!selectedCompanyId || !creditInPlan) {
      setCredit(null);
      return;
    }
    let cancelled = false;
    getCreditSnapshot(selectedCompanyId).then((snapshot) => {
      if (!cancelled) setCredit(snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, creditInPlan]);
  const chosenTerms = (watch("paymentTerms") || "") as TermsKey | "";
  const orderAmount = calculateOrderAmount({
    quantity: Number(watch("quantity")) || 0,
    unitPrice: Number(watch("unitPrice") || selectedItem?.sellingPrice || 0),
    taxRatePercent: selectedItem?.taxRatePercent ? Number(selectedItem.taxRatePercent) : null,
  }).total;
  const effectiveTerms = (chosenTerms || credit?.defaultTerms) as TermsKey | undefined;
  const concerns = credit && effectiveTerms ? creditConcerns(credit, { terms: effectiveTerms, amount: orderAmount }) : [];
  // Terms chosen on the order that are longer than suggested — the one case that needs an override now, not at approval.
  const overridingTerms =
    !!credit && !!chosenTerms && chosenTerms !== credit.defaultTerms && termsExceed(chosenTerms, credit.recommendedTerms);

  function loadCompanyDetails(companyId: string) {
    setValue("locationId", "");
    setValue("proposalId", "");
    // The previous customer's end customer can't apply to this one.
    setValue("endCustomerId", "");
    setEndCustomers([]);
    startCompanyTransition(async () => {
      const [locs, props, parties, ends] = await Promise.all([
        listCompanyLocationOptions(companyId),
        listProposalOptions(companyId),
        listCommissionPartyOptions(companyId),
        listEndCustomers(companyId),
      ]);
      setLocations(locs);
      setProposals(props);
      setCommissionPartyOptions(parties);
      setEndCustomers(ends);
      setValue("locationId", locs.find((l) => l.isPrimary)?.id ?? locs[0]?.id ?? "");
    });
  }

  // Once a Commission expense row has a payee, fetch that commission party's payee accounts
  // (label/PAN/bank/UPI — see CommissionPartyAccount) so the row can offer "which account".
  const payeeIdsKey = (watch("expenses") ?? []).map((e) => e?.payeeCompanyId || "").join(",");
  useEffect(() => {
    const payeeIds = Array.from(new Set(payeeIdsKey.split(",").filter(Boolean)));
    const missing = payeeIds.filter((id) => !fetchedPartyIdsRef.current.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((id) =>
        listCommissionPartyAccounts(id)
          .then((accs) => [id, accs] as const)
          // Only remember a party as fetched once it actually succeeded, so a transient failure
          // doesn't permanently hide the account picker for it.
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled) return;
      const loaded = results.filter((r): r is NonNullable<typeof r> => r !== null);
      loaded.forEach(([id]) => fetchedPartyIdsRef.current.add(id));
      setAccountsByParty((prev) => {
        const next = { ...prev };
        for (const [id, accs] of loaded) {
          next[id] = accs.map((a) => ({ id: a.id, label: a.label, isDefault: a.isDefault }));
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [payeeIdsKey]);

  // A reseller's price comes from their own deal, not the catalog — fill the sale price in and say
  // where the number came from, so nobody quietly bills a partner at list price.
  useEffect(() => {
    if (!isResellerCustomer || !resellersInPlan || !selectedCompanyId || !selectedItemId) {
      setPriceNote(null);
      return;
    }
    let cancelled = false;
    getResellerPriceForItem(selectedCompanyId, selectedItemId).then((pricing) => {
      if (cancelled || !pricing) return;
      const resolved = resolveResellerPrice(pricing);
      setValue("unitPrice", resolved.unitPrice);
      setPriceNote(describePriceSource(resolved));
    });
    return () => {
      cancelled = true;
    };
  }, [isResellerCustomer, resellersInPlan, selectedCompanyId, selectedItemId, setValue]);

  // Suggest Renewal when this customer already has a (non-cancelled/rejected) order for the same
  // item — re-checked whenever either changes. Can't detect "new to us but renewal elsewhere",
  // since that depends on what the customer had before Wroffy, which only the sales person knows.
  useEffect(() => {
    if (!selectedCompanyId || !selectedItemId) return;
    let cancelled = false;
    hasExistingOrderForItem(selectedCompanyId, selectedItemId).then((exists) => {
      if (!cancelled) setValue("businessType", exists ? "RENEWAL" : "NEW");
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCompanyId, selectedItemId, setValue]);

  function toggleWatcher(userId: string) {
    const current = watcherUserIds;
    setValue("watcherUserIds", current.includes(userId) ? current.filter((id) => id !== userId) : [...current, userId]);
  }

  async function onSubmit(values: CreateOrderInput) {
    setServerError(null);
    const result = await createOrder(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.push(`/orders/${result.data.id}`);
  }

  return (
    <Card>
      <CardContent className="pt-5">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && <div className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{serverError}</div>}

          <div className="space-y-1.5">
            <Label htmlFor="companyId">Customer *</Label>
            <Controller
              name="companyId"
              control={control}
              render={({ field }) => (
                <CompanyCombobox
                  companies={companies}
                  value={field.value ?? ""}
                  onSelect={(company) => {
                    field.onChange(company?.id ?? "");
                    if (company) loadCompanyDetails(company.id);
                    else {
                      setLocations([]);
                      setProposals([]);
                      setEndCustomers([]);
                      setValue("endCustomerId", "");
                    }
                  }}
                  placeholder="Type to search customers…"
                />
              )}
            />
            {errors.companyId && <p className="text-xs text-danger">{errors.companyId.message}</p>}
          </div>

          {isResellerCustomer && (
            <div className="space-y-1.5 rounded-md border border-info bg-info-bg p-3">
              <Label htmlFor="endCustomerId">Reseller order — which of their customers is it for?</Label>
              <CompanyCombobox
                id="endCustomerId"
                companies={endCustomers}
                value={watch("endCustomerId") ?? ""}
                onSelect={(company) => setValue("endCustomerId", company?.id ?? "")}
                placeholder="Type to search their customers — or leave blank"
              />
              <p className="text-xs text-muted">
                The order stays with {selectedCompany?.name} — they&apos;re who we invoice. The end customer is who
                it&apos;s delivered/provisioned for, and we never contact them directly.
                {endCustomers.length === 0 && " None on file yet — add one from the reseller's page."}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="locationId">Location *</Label>
            <Select id="locationId" {...register("locationId")} disabled={!selectedCompany}>
              <option value="">Select a location…</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label}
                  {loc.isPrimary ? " (Primary)" : ""}
                </option>
              ))}
            </Select>
            {errors.locationId && <p className="text-xs text-danger">{errors.locationId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="itemId">Product *</Label>
            <Controller
              name="itemId"
              control={control}
              render={({ field }) => (
                <ItemCombobox items={items} value={field.value ?? ""} onSelect={(item) => field.onChange(item?.id ?? "")} showPrice />
              )}
            />
            {errors.itemId && <p className="text-xs text-danger">{errors.itemId.message}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="businessType">New or renewal?</Label>
            <Select id="businessType" {...register("businessType")}>
              {orderBusinessTypeValues.map((t) => (
                <option key={t} value={t}>
                  {orderBusinessTypeLabels[t]}
                </option>
              ))}
            </Select>
            <p className="text-xs text-subtle">
              Suggested automatically from this customer&apos;s order history — change it if the customer already
              had this elsewhere before switching to us.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="quantity">Quantity</Label>
              <Input id="quantity" type="number" min={1} {...register("quantity")} />
              {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="unitPrice">Sales price / unit</Label>
              <Input
                id="unitPrice"
                type="number"
                step="0.01"
                placeholder={selectedItem ? String(selectedItem.sellingPrice) : "Catalog price"}
                {...register("unitPrice")}
              />
              {priceNote ? (
                <p className="text-xs text-info">{priceNote}</p>
              ) : (
                <p className="text-xs text-subtle">Leave blank to use the catalog price.</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="poNumber">Customer PO / invoice number</Label>
              <Input id="poNumber" {...register("poNumber")} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="paymentTerms">Payment terms</Label>
              <Select id="paymentTerms" {...register("paymentTerms")}>
                <option value="">
                  Use customer&apos;s default{credit ? ` (${paymentTermsLabels[credit.defaultTerms]})` : ""}
                </option>
                {paymentTermsValues.map((t) => (
                  <option key={t} value={t}>
                    {paymentTermsLabels[t]}
                  </option>
                ))}
              </Select>
              {credit && (
                <div className="space-y-1.5 text-xs">
                  <p className="flex flex-wrap items-center gap-1.5 text-muted">
                    <CreditBadge rating={credit.rating} score={credit.score} />
                    up to {paymentTermsLabels[credit.recommendedTerms]} · owes {formatCurrency(credit.outstanding)} of a{" "}
                    {formatCurrency(credit.limit)} limit
                  </p>
                  {overridingTerms &&
                    (credit.canOverride ? (
                      <Textarea
                        aria-label="Why give longer terms"
                        placeholder={`Why ${paymentTermsLabels[chosenTerms as TermsKey]}? Kept on the customer's credit record.`}
                        {...register("creditOverrideReason")}
                      />
                    ) : (
                      <p className="text-danger">
                        Longer than their record supports — choose {paymentTermsLabels[credit.recommendedTerms]} or shorter, or leave
                        it on their default.
                      </p>
                    ))}
                  {!overridingTerms && concerns.length > 0 && (
                    <p className="text-warning">
                      Accounts will need a credit override to approve this — {concerns.map((c) => c.text).join("; and ")}.
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="proposalId">Linked proposal</Label>
            <Select id="proposalId" {...register("proposalId")} disabled={!selectedCompany}>
              <option value="">No proposal</option>
              {proposals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.lead.title} — {p.status}
                </option>
              ))}
            </Select>
            {selectedCompany && proposals.length === 0 && (
              <p className="text-xs text-subtle">No proposals on file for this customer yet.</p>
            )}
          </div>

          {isSubscription && (
            <div className="grid grid-cols-2 gap-4 rounded-md bg-surface-sunken p-3">
              <div className="space-y-1.5">
                <Label htmlFor="startDate">Start date</Label>
                <Input id="startDate" type="date" {...register("startDate")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="endDate">Expiry date</Label>
                <Input id="endDate" type="date" {...register("endDate")} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...register("notes")} />
          </div>

          <div className="space-y-2 rounded-md border border-line p-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm">Expenses (commission, freight, etc.)</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => appendExpense({ type: "COMMISSION", amount: 0, notes: "" })}
              >
                + Add expense
              </Button>
            </div>
            {expenseFields.length === 0 && <p className="text-xs text-subtle">No expenses added.</p>}
            {expenseFields.map((field, index) => {
              const expenseType = watch(`expenses.${index}.type`);
              return (
                <div key={field.id} className="space-y-1.5">
                  <div className="flex items-start gap-2">
                    {/* aria-label rather than a htmlFor pairing: these repeat per expense row, so a
                        label would need a unique id anyway, and the row number is what tells a
                        screen reader which of five amount boxes it has landed in. */}
                    <Select
                      {...register(`expenses.${index}.type` as const)}
                      className="w-36"
                      aria-label={`Expense ${index + 1} type`}
                    >
                      {orderExpenseTypeValues.map((t) => (
                        <option key={t} value={t}>
                          {orderExpenseTypeLabels[t]}
                        </option>
                      ))}
                    </Select>
                    <Input type="number" step="0.01" placeholder="Amount" className="w-32" aria-label={`Expense ${index + 1} amount`} {...register(`expenses.${index}.amount` as const)} />
                    <Input placeholder="Notes (optional)" aria-label={`Expense ${index + 1} notes`} {...register(`expenses.${index}.notes` as const)} />
                    <Button type="button" variant="ghost" size="sm" onClick={() => removeExpense(index)}>
                      Remove
                    </Button>
                  </div>
                  {expenseType === "COMMISSION" && (
                    <div className="flex flex-wrap items-start gap-2">
                      <div>
                        <div className="w-64">
                          <CompanyCombobox
                            companies={commissionPartyOptions.map((p) => ({
                              id: p.id,
                              name: p.name,
                              hint: p.linked ? "(linked to this customer)" : undefined,
                            }))}
                            value={watch(`expenses.${index}.payeeCompanyId`) ?? ""}
                            onSelect={(party) => {
                              setValue(`expenses.${index}.payeeCompanyId`, party?.id ?? "");
                              // The account list belongs to the previous payee — clear it, or the order
                              // records a payout into an account owned by a different commission party.
                              setValue(`expenses.${index}.payeeAccountId`, "");
                            }}
                            placeholder="Paid to — search commission parties…"
                          />
                        </div>
                        {commissionPartyOptions.length === 0 && (
                          <p className="mt-1 text-xs text-subtle">
                            No commission parties on file yet — add one from the Commission Parties module first.
                          </p>
                        )}
                        {errors.expenses?.[index]?.payeeCompanyId && (
                          <p className="mt-1 text-xs text-danger">{errors.expenses[index]?.payeeCompanyId?.message}</p>
                        )}
                      </div>
                      {watch(`expenses.${index}.payeeCompanyId`) &&
                        (accountsByParty[watch(`expenses.${index}.payeeCompanyId`) ?? ""]?.length ?? 0) > 0 && (
                          <div>
                            <Select
                              {...register(`expenses.${index}.payeeAccountId` as const)}
                              className="w-56"
                              aria-label={`Expense ${index + 1} payee account`}
                            >
                              <option value="">Which account? (optional)</option>
                              {accountsByParty[watch(`expenses.${index}.payeeCompanyId`) ?? ""]?.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.label}
                                  {a.isDefault ? " (default)" : ""}
                                </option>
                              ))}
                            </Select>
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
            {errors.expenses && <p className="text-xs text-danger">Check the expense amounts entered.</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Watchers (stakeholder visibility — e.g. Tech Support, HR for installation/demo/delivery)</Label>
            <div className="grid grid-cols-2 gap-1.5 rounded-md border border-line p-3 sm:grid-cols-3">
              {users.map((u) => (
                <label key={u.id} className="flex items-center gap-1.5 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={watcherUserIds.includes(u.id)}
                    onChange={() => toggleWatcher(u.id)}
                    className="h-3.5 w-3.5"
                  />
                  {u.name}
                </label>
              ))}
            </div>
          </div>

          <p className="text-xs text-subtle">
            An Order ID is generated automatically once punched. The vendor and purchase price are set later by the
            purchase team, after Accounts approves.
          </p>

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="secondary" onClick={() => router.back()}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Submitting…" : "Punch order"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
