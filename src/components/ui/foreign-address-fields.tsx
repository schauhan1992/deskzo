"use client";

import { useState } from "react";
import { Input, Label, Select } from "@/components/ui/input";
import { OutboundLink } from "@/components/ui/outbound-link";
import { lookupWorldPostalCached, useWorldCities, useWorldStates } from "@/components/ui/use-address-lookup";
import { countryByName } from "@/lib/geo/countries";
import { postalLooksWrong } from "@/lib/geo/geonames";

const TYPE_IT = "__type-it__";

/**
 * State, city and postal code for an address outside India — from GeoNames (src/lib/geo/world-lookup.ts).
 *
 * Helpful, never in the way. The state is a list where GeoNames has one, with a way out for a place
 * it does not; the city suggests the biggest towns first but takes anything; the postal code fills in
 * whatever is still empty and flags a code that looks wrong for the country — and saves it anyway.
 * None of this moves tax: outside India the place of supply is the country, so a foreign address can
 * afford to be forgiving in a way an Indian one cannot.
 *
 * Renders grid cells for AddressFields' grid, not a grid of its own.
 */
export function ForeignAddressFields({
  uid,
  country,
  state,
  city,
  pincode,
  onChange,
  disabled,
  showPincode,
}: {
  uid: string;
  country: string;
  state: string;
  city: string;
  pincode: string;
  onChange: (patch: { state?: string; city?: string; pincode?: string }) => void;
  disabled?: boolean;
  showPincode: boolean;
}) {
  const entry = countryByName(country);
  const code = entry?.code ?? null;
  const states = useWorldStates(code, !disabled && !!code);
  const stateCode = states.find((s) => s.name === state)?.code ?? null;
  const cities = useWorldCities(code, stateCode, city, !disabled && !!code);
  // The picker, until somebody says their state is not in it.
  const [typingState, setTypingState] = useState(false);
  const [found, setFound] = useState<{ key: string; text: string; tone: "ok" | "warn" } | null>(null);

  const listed = states.some((s) => s.name === state);
  const showList = states.length > 0 && !typingState;
  const formatHint = entry && pincode ? postalLooksWrong(entry, pincode) : null;
  const foundNow = found && found.key === `${code}|${pincode.trim().toUpperCase()}` ? found : null;

  function lookUp() {
    const value = pincode.trim();
    if (!code || value.length < 2 || disabled) return;
    const key = `${code}|${value.toUpperCase()}`;
    lookupWorldPostalCached(code, value)
      .then((r) => {
        if (!r.ok) {
          // No data for the country says nothing about the code; only a real miss is worth saying.
          setFound(r.reason === "not-found" ? { key, tone: "warn", text: "Not in GeoNames' list — check it, or carry on if you're sure." } : null);
          return;
        }
        // Only what is still empty — never overwrite what somebody typed on purpose.
        onChange({
          ...(!state.trim() && r.stateName && (states.length === 0 || states.some((s) => s.name === r.stateName)) ? { state: r.stateName } : {}),
          ...(!city.trim() && r.city ? { city: r.city } : {}),
        });
        setFound({
          key,
          tone: "ok",
          text: `${r.partial ? "Area " : ""}${[r.city, r.stateName].filter(Boolean).join(", ")}${r.places.length > 1 ? ` — also ${r.places.filter((p) => p !== r.city).slice(0, 3).join(", ")}` : ""}`,
        });
      })
      .catch(() => {});
  }

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-state`}>State / province</Label>
        {showList ? (
          <Select
            id={`${uid}-state`}
            value={state}
            disabled={disabled}
            onChange={(e) => {
              if (e.target.value === TYPE_IT) {
                setTypingState(true);
                return;
              }
              onChange({ state: e.target.value, city: "" });
            }}
          >
            <option value="">Choose…</option>
            {states.map((s) => (
              <option key={s.code} value={s.name}>
                {s.name}
              </option>
            ))}
            {/* Whatever was stored before this list existed, kept rather than blanked. */}
            {state && !listed && <option value={state}>{state}</option>}
            <option value={TYPE_IT}>Not in the list — type it</option>
          </Select>
        ) : (
          <Input
            id={`${uid}-state`}
            value={state}
            disabled={disabled}
            placeholder="State, province or region"
            autoComplete="off"
            onChange={(e) => onChange({ state: e.target.value })}
          />
        )}
        {typingState && states.length > 0 && (
          <button type="button" className="text-[11px] text-muted hover:text-text hover:underline" onClick={() => setTypingState(false)}>
            Back to the list
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${uid}-city`}>City</Label>
        <Input
          id={`${uid}-city`}
          value={city}
          disabled={disabled}
          list={cities.length > 0 ? `${uid}-cities` : undefined}
          placeholder={stateCode ? "City" : "Start typing for suggestions"}
          autoComplete="off"
          onChange={(e) => onChange({ city: e.target.value })}
        />
        {cities.length > 0 && (
          <datalist id={`${uid}-cities`}>
            {cities.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        )}
      </div>

      {showPincode && (
        <div className="space-y-1.5">
          <Label htmlFor={`${uid}-pincode`}>Postal code</Label>
          <Input
            id={`${uid}-pincode`}
            value={pincode}
            disabled={disabled}
            maxLength={12}
            placeholder={entry?.postalFormat ? entry.postalFormat.split("|")[0].replace(/#/g, "9").replace(/@/g, "A") : "Postal code"}
            autoComplete="off"
            onChange={(e) => onChange({ pincode: e.target.value })}
            onBlur={lookUp}
          />
          {foundNow ? (
            <p className={`text-[11px] ${foundNow.tone === "ok" ? "text-success" : "text-warning"}`}>{foundNow.text}</p>
          ) : (
            formatHint && <p className="text-[11px] text-warning">{formatHint}</p>
          )}
        </div>
      )}

      {/* The credit GeoNames' licence asks for, where its data is offered. */}
      <p className="col-span-full -mt-1 text-[11px] text-subtle">
        Places outside India from{" "}
        <OutboundLink href="https://www.geonames.org/" className="hover:text-text hover:underline">
          GeoNames
        </OutboundLink>{" "}
        (CC BY 4.0).
      </p>
    </>
  );
}
