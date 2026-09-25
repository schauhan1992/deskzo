"use client";

import { Input, Label } from "@/components/ui/input";
import { lookupPincodeCached, usePincodeLookup, usePincodeSuggestions } from "@/components/ui/use-address-lookup";

/**
 * A PIN code, checked against India Post's directory as it is typed.
 *
 * It works in both directions of the hierarchy:
 *
 *   · **PIN first.** The sixth digit fills in the state and city — but only fields that are empty.
 *     Nothing somebody has already chosen is overwritten on the strength of a number they may have
 *     mistyped.
 *   · **PIN last.** Once a city is chosen the field offers that city's PINs, each labelled with the
 *     locality it serves, so picking one is choosing "Connaught Place" rather than recalling 110001.
 *
 * ## When the PIN and the state disagree
 *
 * It says so, names the state the PIN is really in, and offers to switch — it does not switch by
 * itself. The state decides CGST + SGST against IGST, so changing it is a decision about tax; a
 * form that silently re-taxed a document because of a PIN typo would be worse than one that let the
 * mismatch through. The disagreement is the useful part: it is how a state picked from the wrong
 * line of the dropdown gets caught before an invoice goes out under it.
 *
 * Only for Indian addresses. Everywhere else it is a postal code and there is nothing to check it
 * against — the caller renders a plain field instead.
 */
export function PincodeField({
  id,
  value,
  stateName,
  stateCode,
  city,
  disabled,
  onPincode,
  onPlace,
}: {
  id: string;
  value: string;
  /** The state as chosen — used to find PIN suggestions for the city. */
  stateName: string;
  /** Its GST code, or null when none is chosen or it does not resolve. */
  stateCode: string | null;
  city: string;
  disabled?: boolean;
  onPincode: (pincode: string) => void;
  /** Set the state and/or city from the directory. Only the keys present change. */
  onPlace: (place: { stateCode?: string; stateName?: string; city?: string }) => void;
}) {
  const lookup = usePincodeLookup(value, !disabled);
  const suggestions = usePincodeSuggestions(stateName, city, !disabled && !!stateCode);

  const hasState = Boolean(stateName.trim());
  const found = lookup?.ok ? lookup : null;
  const mismatch = Boolean(found?.stateCode && hasState && found.stateCode !== stateCode);

  function typed(next: string) {
    const pin = next.replace(/\D/g, "").slice(0, 6);
    onPincode(pin);
    if (pin.length !== 6) return;
    // Filled in response to typing, never on opening a form — an existing address with a PIN and no
    // state should be shown as it is, not quietly edited and marked dirty.
    lookupPincodeCached(pin)
      .then((result) => {
        if (!result.ok || !result.stateCode) return;
        if (!hasState) {
          onPlace({ stateCode: result.stateCode, stateName: result.stateName, ...(city.trim() ? {} : { city: result.city }) });
        } else if (result.stateCode === stateCode && !city.trim()) {
          onPlace({ city: result.city });
        }
      })
      .catch(() => {});
  }

  const listId = `${id}-pins`;

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>PIN code</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        inputMode="numeric"
        maxLength={6}
        placeholder={suggestions.length > 0 ? "Pick or type a PIN" : "560001"}
        autoComplete="off"
        list={suggestions.length > 0 ? listId : undefined}
        onChange={(e) => typed(e.target.value)}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s.pincode} value={s.pincode}>
              {s.area}
            </option>
          ))}
        </datalist>
      )}

      {mismatch && found ? (
        <p className="text-[11px] text-warning">
          {found.pincode} is in {found.city}, {found.stateName} — not the state chosen above.{" "}
          <button
            type="button"
            className="font-medium underline underline-offset-2"
            onClick={() => onPlace({ stateCode: found.stateCode!, stateName: found.stateName, city: found.city })}
          >
            Use {found.stateName}
          </button>
        </p>
      ) : found ? (
        <p className="truncate text-[11px] text-subtle" title={found.localities.join(", ")}>
          {found.localities.slice(0, 2).join(", ")}
          {found.localities.length > 2 ? ` +${found.localities.length - 2}` : ""} · {found.city}, {found.stateName}
        </p>
      ) : lookup && !lookup.ok && lookup.reason === "not-found" ? (
        <p className="text-[11px] text-warning">Not in India Post&apos;s directory — worth checking the number.</p>
      ) : null}
    </div>
  );
}
