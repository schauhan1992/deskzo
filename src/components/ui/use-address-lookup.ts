"use client";

import { useEffect, useState } from "react";
import {
  citySuggestions,
  lookupPincode,
  lookupWorldPostal,
  pincodeSuggestions,
  worldCities,
  worldStates,
  type PinLookup,
  type PinSuggestion,
} from "@/actions/geo";
import type { WorldPostalLookup, WorldState } from "@/lib/geo/world-lookup";
import { citiesIn } from "@/lib/geo/india";

/**
 * The PIN directory, from a form.
 *
 * Each hook answers for the inputs it was *given* — the result is stored beside the key it was
 * fetched for, and returned only while that key is still current. A slow answer for "Karnataka"
 * arriving after the user has moved on to "Kerala" is therefore never shown, without any
 * cancellation bookkeeping beyond ignoring a late reply.
 *
 * Answers are cached for the life of the page: a state's cities do not change while somebody is
 * filling in a form, and the billing and shipping editors on one document ask the same questions.
 */

const cityCache = new Map<string, string[]>();
const pinListCache = new Map<string, PinSuggestion[]>();
const lookupCache = new Map<string, PinLookup>();

/** One lookup, cached — shared by the hint below the field and the autofill as the PIN is typed. */
export function lookupPincodeCached(pincode: string): Promise<PinLookup> {
  const hit = lookupCache.get(pincode);
  if (hit) return Promise.resolve(hit);
  return lookupPincode(pincode).then((result) => {
    // A failure to reach the server is not an answer about the PIN, so only real answers are kept.
    lookupCache.set(pincode, result);
    return result;
  });
}

/**
 * Cities for a state — the curated list at once, the directory's districts when they arrive.
 *
 * Never empty-then-full: `citiesIn` is what shows until the server answers, and it is what stays if
 * the server cannot, so the field is never worse than it was before the directory existed.
 */
export function useCitySuggestions(state: string, enabled: boolean): string[] {
  const [result, setResult] = useState<{ key: string; cities: string[] } | null>(null);

  useEffect(() => {
    if (!enabled || !state) return;
    let live = true;
    const hit = cityCache.get(state);
    (hit ? Promise.resolve(hit) : citySuggestions(state))
      .then((cities) => {
        cityCache.set(state, cities);
        if (live) setResult({ key: state, cities });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [state, enabled]);

  return enabled && result?.key === state ? result.cities : citiesIn(state);
}

/** PINs in the chosen city, fetched once typing in the city box has paused. */
export function usePincodeSuggestions(state: string, city: string, enabled: boolean): PinSuggestion[] {
  const key = `${state}|${city.trim().toLowerCase()}`;
  const [result, setResult] = useState<{ key: string; pins: PinSuggestion[] } | null>(null);

  useEffect(() => {
    if (!enabled || !state || city.trim().length < 2) return;
    let live = true;
    const hit = pinListCache.get(key);
    // Debounced, because the city box is typed into: "B", "Be", "Ben"… each would otherwise be a
    // query, and only the last one is ever looked at.
    const timer = setTimeout(
      () => {
        (hit ? Promise.resolve(hit) : pincodeSuggestions(state, city))
          .then((pins) => {
            pinListCache.set(key, pins);
            if (live) setResult({ key, pins });
          })
          .catch(() => {});
      },
      hit ? 0 : 350,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, state, city, enabled]);

  return enabled && result?.key === key ? result.pins : [];
}

/** What the directory says about a complete PIN — for the hint under the field. */
export function usePincodeLookup(pincode: string, enabled: boolean): PinLookup | null {
  const pin = pincode.replace(/\s+/g, "");
  const [result, setResult] = useState<{ key: string; lookup: PinLookup } | null>(null);

  useEffect(() => {
    if (!enabled || !/^\d{6}$/.test(pin)) return;
    let live = true;
    lookupPincodeCached(pin)
      .then((lookup) => {
        if (live) setResult({ key: pin, lookup });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pin, enabled]);

  return enabled && result?.key === pin ? result.lookup : null;
}

// ─── Outside India ────────────────────────────────────────────────────────────────────────────────
//
// The same shape as the PIN hooks above, over GeoNames' tables: cached for the life of the page,
// debounced where the input is typed, and silent on a failure to reach the server.

const worldStateCache = new Map<string, WorldState[]>();
const worldCityCache = new Map<string, string[]>();
const worldPostalCache = new Map<string, WorldPostalLookup>();

/** The states and provinces of a country outside India — empty until loaded, or where none are known. */
export function useWorldStates(countryCode: string | null, enabled: boolean): WorldState[] {
  const [result, setResult] = useState<{ key: string; states: WorldState[] } | null>(null);
  useEffect(() => {
    if (!enabled || !countryCode) return;
    let live = true;
    const hit = worldStateCache.get(countryCode);
    (hit ? Promise.resolve(hit) : worldStates(countryCode))
      .then((states) => {
        worldStateCache.set(countryCode, states);
        if (live) setResult({ key: countryCode, states });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [countryCode, enabled]);
  return enabled && countryCode && result?.key === countryCode ? result.states : (countryCode ? (worldStateCache.get(countryCode) ?? []) : []);
}

/** Towns to suggest as the city is typed — the biggest in the state first. */
export function useWorldCities(countryCode: string | null, stateCode: string | null, typed: string, enabled: boolean): string[] {
  const key = `${countryCode}|${stateCode ?? ""}|${typed.trim().toLowerCase().slice(0, 20)}`;
  const [result, setResult] = useState<{ key: string; cities: string[] } | null>(null);
  useEffect(() => {
    if (!enabled || !countryCode || (!stateCode && typed.trim().length < 2)) return;
    let live = true;
    const hit = worldCityCache.get(key);
    const timer = setTimeout(
      () => {
        (hit ? Promise.resolve(hit) : worldCities(countryCode, stateCode, typed.trim().slice(0, 20)))
          .then((cities) => {
            worldCityCache.set(key, cities);
            if (live) setResult({ key, cities });
          })
          .catch(() => {});
      },
      hit ? 0 : 300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, countryCode, stateCode, typed, enabled]);
  return enabled && result?.key === key ? result.cities : [];
}

export function lookupWorldPostalCached(countryCode: string, code: string): Promise<WorldPostalLookup> {
  const key = `${countryCode}|${code.toUpperCase().replace(/[s-]+/g, "")}`;
  const hit = worldPostalCache.get(key);
  if (hit) return Promise.resolve(hit);
  return lookupWorldPostal(countryCode, code).then((result) => {
    worldPostalCache.set(key, result);
    return result;
  });
}
