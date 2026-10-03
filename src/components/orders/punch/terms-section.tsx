"use client";

import { useWatch } from "react-hook-form";
import { handoffValues } from "@/lib/validation/order";
import { paymentTermsLabels, paymentTermsValues } from "@/lib/gst";
import { creditConcerns, termsExceed, type TermsKey } from "@/lib/credit/engine";
import { handoffLabels } from "@/lib/orders/handoff-rules";
import { useClock } from "@/components/time/clock-provider";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import type { ItemComboOption } from "@/components/items/item-combobox";
import { FieldError, Section } from "./parts";
import { usePriceFigures } from "./use-figures";
import { invalidProps, type CreditSnapshot, type PunchErrors, type PunchForm } from "./types";

/**
 * When the customer pays and when purchase may start: the payment terms, weighed against the
 * customer's credit as they are chosen, and the hand-off to purchase.
 *
 * Terms longer than the customer's record supports are the one credit question settled here rather
 * than at approval — they need a reason now, from somebody allowed to give one.
 */
export function TermsSection({
  form,
  errors,
  credit,
  selectedItem,
}: {
  form: PunchForm;
  errors: PunchErrors;
  credit: CreditSnapshot;
  selectedItem: ItemComboOption | null;
}) {
  const { control, register } = form;
  const { total } = usePriceFigures(control, selectedItem);
  const [paymentTerms, handoff] = useWatch({ control, name: ["paymentTerms", "handoff"] });
  const clock = useClock();

  const chosenTerms = (paymentTerms || "") as TermsKey | "";
  const effectiveTerms = (chosenTerms || credit?.defaultTerms) as TermsKey | undefined;
  const concerns = credit && effectiveTerms ? creditConcerns(credit, { terms: effectiveTerms, amount: total }) : [];
  // Terms chosen on the order that are longer than suggested — the one case that needs an override now, not at approval.
  const overridingTerms =
    !!credit && !!chosenTerms && chosenTerms !== credit.defaultTerms && termsExceed(chosenTerms, credit.recommendedTerms);

  // The workspace's today, whatever the browser's clock zone: the earliest go-ahead day is the one after it.
  const { year, month, day } = clock.parts(new Date());
  const tomorrow = clock.dateKey(clock.midnight(year, month, day + 1));

  return (
    <Section title="Terms and hand-off">
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
        {credit && overridingTerms &&
          (credit.canOverride ? (
            <>
              <Textarea
                aria-label="Why give longer terms"
                placeholder={`Why ${paymentTermsLabels[chosenTerms as TermsKey]}? Kept on the customer's credit record.`}
                maxLength={500}
                className="aria-[invalid=true]:border-danger"
                {...register("creditOverrideReason")}
                {...invalidProps("creditOverrideReason", errors.creditOverrideReason?.message)}
              />
              <FieldError id="creditOverrideReason" message={errors.creditOverrideReason?.message} />
            </>
          ) : (
            <p className="text-xs text-danger">
              Longer than their record supports — choose {paymentTermsLabels[credit.recommendedTerms]} or shorter, or leave it on
              their default.
            </p>
          ))}
        {!overridingTerms && concerns.length > 0 && (
          <p className="text-xs text-warning">
            Accounts will need a credit override to approve this — {concerns.map((c) => c.text).join("; and ")}.
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-medium text-muted">Purchase hand-off</legend>
        <p className="text-xs text-subtle">When purchase may start on it. A held order stays out of their queue until you send it.</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {handoffValues.map((h) => (
            <label key={h} className="flex items-center gap-1.5 text-sm text-text">
              <input type="radio" value={h} {...register("handoff")} className="h-3.5 w-3.5 accent-[var(--brand)]" />
              {handoffLabels[h]}
            </label>
          ))}
        </div>
        {handoff === "SCHEDULE" && (
          <div className="space-y-1.5">
            <Label htmlFor="releaseOn">Goes to purchase on</Label>
            <Input
              id="releaseOn"
              type="date"
              min={tomorrow}
              className="w-48 aria-[invalid=true]:border-danger"
              {...register("releaseOn")}
              {...invalidProps("releaseOn", errors.releaseOn?.message)}
            />
            <FieldError id="releaseOn" message={errors.releaseOn?.message} />
          </div>
        )}
        {handoff !== undefined && handoff !== "NOW" && (
          <p className="text-xs text-subtle">
            It counts toward targets once a payment comes in or it goes to purchase, whichever is first.
          </p>
        )}
      </fieldset>
    </Section>
  );
}
