"use client";

import { useId } from "react";
import { COUNTRIES, DEFAULT_COUNTRY, isIndia } from "@/lib/geo/countries";
import { INDIAN_STATES } from "@/lib/geo/india";
import { stateCodeFromName } from "@/lib/gst-engine";
import { Input, Label, Select } from "@/components/ui/input";
import { PincodeField } from "@/components/ui/pincode-field";
import { useCitySuggestions } from "@/components/ui/use-address-lookup";
import { ForeignAddressFields } from "@/components/ui/foreign-address-fields";

/**
 * Country, state and city — picked rather than typed.
 *
 * ## The state is the one that matters
 *
 * It is not a label. `stateCodeFromName` turns it into a GST state code, and that code is what
 * decides CGST + SGST against IGST. A spelling the lookup cannot match yields no code, and the
 * supply is then treated as inter-state — so a Gurugram customer entered as "harayna" is charged
 * IGST on a Haryana-to-Haryana sale, silently, and the customer cannot claim the credit. There is
 * a row exactly like that in this database, typed by hand.
 *
 * So within India the state is a closed list built from the tax engine's own table. Outside India
 * no GST code applies, so the state, city and postal code come from GeoNames as help rather than as
 * rules — see ForeignAddressFields, which also keeps any foreign state from ever reaching the GST
 * lookup (Pakistan's "Punjab" is not India's).
 *
 * ## The city is open on purpose
 *
 * A `datalist`, not a `select`. India has thousands of towns and a customer is as likely to be in
 * Hosur or Bhiwadi as in Mumbai; a closed list that could not express where somebody actually is
 * would be worse than the free text it replaced, because it would push people to pick the nearest
 * wrong answer. The suggestions save typing and keep the spelling steady for the places that come
 * up again and again — and anything else still goes in.
 *
 * ## Uncontrolled by design
 *
 * Every form this goes into manages its own state differently — three use `react-hook-form`, the
 * rest hold their own. So this takes values and change handlers and owns nothing, which is what
 * lets one component serve all of them without each one bending to it.
 */
export function AddressFields({
  country,
  state,
  city,
  pincode,
  onChange,
  disabled,
  /** Leaves the PIN code out, for the forms that keep it elsewhere or do not collect one. */
  showPincode = true,
  showCountry = true,
  /** Renders as three across on wide screens; set for the narrow panes that need one per row. */
  columns = 3,
}: {
  country: string;
  state: string;
  city: string;
  pincode?: string;
  onChange: (patch: { country?: string; state?: string; city?: string; pincode?: string }) => void;
  disabled?: boolean;
  showPincode?: boolean;
  /**
   * Leaves the country out, for addresses that are domestic by definition.
   *
   * An employee's home address is one: payroll, professional tax and attendance all assume
   * India, so offering every country there is a field nobody will ever change and everybody has
   * to look past. The state list stays closed either way — with no country shown it is India,
   * which is exactly when the GST table applies.
   */
  showCountry?: boolean;
  columns?: 1 | 2 | 3;
}) {
  // `useId` rather than literals: a document form renders this twice, for billing and for shipping,
  // and duplicate ids would point both sets of labels at whichever rendered first.
  const uid = useId();
  const domestic = isIndia(country);
  // The curated list at once, then every district India Post knows for the state — see the hook.
  const suggestions = useCitySuggestions(state, domestic && !disabled);
  /**
   * Two different questions about a stored state, kept apart.
   *
   * `listed` is whether it is spelled exactly as an option — the select needs that to show it.
   * `resolves` is whether the tax engine can turn it into a GST code, which is the one that
   * matters. "Jammu and Kashmir" is not listed and does resolve; "harayna" is neither. Only the
   * second deserves the warning, because only the second is actually taxed wrongly.
   */
  const listed = INDIAN_STATES.some((s) => s.name === state);
  const resolves = stateCodeFromName(state) !== null;

  const grid = columns === 1 ? "grid-cols-1" : columns === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3";

  return (
    <div className={`grid grid-cols-1 gap-3 ${grid}`}>
      {showCountry && (
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-country`}>Country</Label>
        <Select
          id={`${uid}-country`}
          value={country || DEFAULT_COUNTRY}
          disabled={disabled}
          onChange={(e) => {
            /**
             * Moving country clears the state, and the city with it.
             *
             * Keeping "Maharashtra" under Singapore would leave a value the tax engine still
             * resolves to code 27, so a foreign address would quietly carry an Indian place of
             * supply. Clearing is the only safe answer; re-picking is two clicks.
             */
            onChange({ country: e.target.value, state: "", city: "" });
          }}
        >
          {COUNTRIES.map((c) => (
            <option key={c.code} value={c.name}>
              {c.name}
            </option>
          ))}
          {/* A country typed before the list was complete, kept rather than silently replaced. */}
          {country && !COUNTRIES.some((c) => c.name === country) && <option value={country}>{country}</option>}
        </Select>
      </div>
      )}

      {domestic ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-state`}>State</Label>
            <Select
              id={`${uid}-state`}
              value={state}
              disabled={disabled}
              onChange={(e) => onChange({ state: e.target.value, city: "" })}
            >
              <option value="">Choose a state…</option>
              {INDIAN_STATES.map((s) => (
                <option key={s.code} value={s.name}>
                  {s.name}
                </option>
              ))}
              {/* A value stored before this picker existed, and not in the list. Offered so that
                  opening a form does not silently change somebody's address to blank — but named as
                  the problem it is, because it resolves to no GST code. */}
              {state && !listed && (
                <option value={state}>{resolves ? state : `${state} — not a GST state, please correct`}</option>
              )}
            </Select>
            {state && !resolves && (
              <p className="text-[11px] text-danger">
                This doesn&apos;t match a GST state, so tax on this address is worked out as inter-state.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`${uid}-city`}>City</Label>
            <Input
              id={`${uid}-city`}
              value={city}
              disabled={disabled}
              list={suggestions.length > 0 ? `${uid}-cities` : undefined}
              placeholder={!state ? "Pick a state first for suggestions" : "City"}
              autoComplete="off"
              onChange={(e) => onChange({ city: e.target.value })}
            />
            {suggestions.length > 0 && (
              <datalist id={`${uid}-cities`}>
                {suggestions.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            )}
          </div>

          {showPincode && (
            <PincodeField
              id={`${uid}-pincode`}
              value={pincode ?? ""}
              stateName={state}
              stateCode={stateCodeFromName(state)}
              city={city}
              disabled={disabled}
              onPincode={(value) => onChange({ pincode: value })}
              onPlace={(place) =>
                onChange({
                  ...(place.stateName ? { state: place.stateName } : {}),
                  ...(place.city ? { city: place.city } : {}),
                })
              }
            />
          )}
        </>
      ) : (
        <ForeignAddressFields
          uid={uid}
          country={country}
          state={state}
          city={city}
          pincode={pincode ?? ""}
          onChange={onChange}
          disabled={disabled}
          showPincode={showPincode}
        />
      )}
    </div>
  );
}
