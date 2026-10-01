"use client";

import { Controller } from "react-hook-form";
import { searchCustomerOptions } from "@/actions/company";
import { paymentTermsLabels } from "@/lib/gst";
import { formatCurrency } from "@/lib/utils";
import { Input, Label, Select } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { CreditBadge } from "@/components/credit/credit-badge";
import { FieldError, Section } from "./parts";
import { invalidProps, type CreditSnapshot, type CustomerContext, type PunchErrors, type PunchForm } from "./types";

/**
 * Who the order is for: the customer, their credit as they are chosen, a reseller's end customer, the
 * office it goes to and the customer's own reference.
 *
 * Everything below the customer comes from one lookup made when they are chosen (`punchCustomerContext`),
 * so until it answers the location says it is loading rather than offering an empty list.
 */
export function CustomerSection({
  form,
  errors,
  companies,
  customerSearch,
  companyId,
  selectedCompany,
  context,
  contextLoading,
  contextFailed,
  credit,
  onCustomerChange,
  onRetryContext,
}: {
  form: PunchForm;
  errors: PunchErrors;
  companies: CompanyComboOption[];
  customerSearch: boolean;
  companyId: string;
  selectedCompany: CompanyComboOption | undefined;
  context: CustomerContext | null;
  contextLoading: boolean;
  contextFailed: boolean;
  /** Null when there is none to show: no customer yet, Receivables not in the plan, or no payments view. */
  credit: CreditSnapshot;
  onCustomerChange: (company: CompanyComboOption | null) => void;
  /** Asks for the chosen customer's details again after the lookup failed. */
  onRetryContext: () => void;
}) {
  const { control, register } = form;
  const isReseller = selectedCompany?.relationshipType === "RESELLER";
  const locations = context?.locations ?? [];
  const endCustomers = context?.endCustomers ?? [];

  return (
    <Section title="Customer">
      {/* `data-search` says whether the picker searches the server, which nothing else in the markup shows until it is typed in. */}
      <div className="space-y-1.5 sm:col-span-2" data-search={customerSearch ? "server" : "list"}>
        <Label htmlFor="companyId">Customer *</Label>
        <Controller
          name="companyId"
          control={control}
          render={({ field }) => (
            <CompanyCombobox
              id="companyId"
              inputRef={field.ref}
              companies={companies}
              value={field.value ?? ""}
              // A book too long to send whole is searched on the server; the page says when it is.
              search={customerSearch ? searchCustomerOptions : undefined}
              autoHighlightFirst
              {...invalidProps("companyId", errors.companyId?.message)}
              onSelect={(company) => {
                field.onChange(company?.id ?? "");
                onCustomerChange(company);
              }}
              placeholder="Type to search customers…"
            />
          )}
        />
        <FieldError id="companyId" message={errors.companyId?.message} />
        {credit && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <CreditBadge rating={credit.rating} score={credit.score} />
            up to {paymentTermsLabels[credit.recommendedTerms]} · owes {formatCurrency(credit.outstanding)} of a{" "}
            {formatCurrency(credit.limit)} limit
          </p>
        )}
        {contextFailed && (
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-danger">
            Couldn&apos;t load this customer&apos;s details.
            <button type="button" onClick={onRetryContext} className="font-medium underline underline-offset-2 hover:no-underline">
              Try again
            </button>
          </p>
        )}
      </div>

      {isReseller && (
        <div className="space-y-1.5 rounded-md border border-info bg-info-bg p-3 sm:col-span-2">
          <Label htmlFor="endCustomerId">Reseller order — which of their customers is it for?</Label>
          <Controller
            name="endCustomerId"
            control={control}
            render={({ field }) => (
              <CompanyCombobox
                id="endCustomerId"
                inputRef={field.ref}
                companies={endCustomers}
                value={field.value ?? ""}
                // Optional: Enter on a typed name takes the top match, and on an empty field still submits.
                autoHighlightFirst="typed"
                onSelect={(company) => field.onChange(company?.id ?? "")}
                placeholder="Type to search their customers — or leave blank"
              />
            )}
          />
          <p className="text-xs text-muted">
            We invoice {selectedCompany?.name}; the end customer is who it&apos;s delivered to, and we never contact them.
            {!contextLoading && endCustomers.length === 0 && " None on file yet — add one from the reseller's page."}
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="locationId">Location *</Label>
        {/*
          Controlled rather than registered: the offices arrive after the customer is chosen, and the
          primary one is selected as they do. A registered select is set straight on the DOM, where
          an option that hasn't rendered yet can't be chosen; a controlled one is set after it has.
        */}
        <Controller
          name="locationId"
          control={control}
          render={({ field }) => (
            <Select
              id="locationId"
              ref={field.ref}
              name={field.name}
              value={field.value ?? ""}
              onChange={field.onChange}
              onBlur={field.onBlur}
              disabled={!companyId || contextLoading}
              className="aria-[invalid=true]:border-danger"
              {...invalidProps("locationId", errors.locationId?.message)}
            >
              <option value="">{contextLoading ? "Loading…" : companyId ? "Select a location…" : "Choose the customer first"}</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label}
                  {loc.isPrimary ? " (Primary)" : ""}
                </option>
              ))}
            </Select>
          )}
        />
        <FieldError id="locationId" message={errors.locationId?.message} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="poNumber">Customer PO / invoice number</Label>
        <Input id="poNumber" {...register("poNumber")} />
      </div>
    </Section>
  );
}
