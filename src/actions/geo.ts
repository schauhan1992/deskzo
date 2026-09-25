"use server";

import { db } from "@/lib/db";
import { GST_STATE_CODES, stateCodeFromName } from "@/lib/gst-engine";
import { citiesIn } from "@/lib/geo/india";
import { cityForPin, mergeCitySuggestions, officeLocality, pinSearchFor, titleCase } from "@/lib/geo/pincode";
import { citiesIn as worldCitiesIn, findPostal, statesOf, type WorldPostalLookup, type WorldState } from "@/lib/geo/world-lookup";

/**
 * Lookups against India Post's PIN directory, for the address forms.
 *
 * ## No session, on purpose
 *
 * The new-joiner intake form is public — a candidate fills it in from a link, signed in to nothing —
 * and it collects an address like every other form. These answer questions about the country's post
 * offices, which the Department of Posts publishes for anybody, so there is nothing here to protect.
 * What is bounded instead is the work: inputs are length-checked before any query and every answer
 * is capped, so a caller cannot make one of these expensive.
 *
 * ## Answers that say why they are empty
 *
 * "Not in the directory" and "there is no directory" look the same as an empty result and mean
 * opposite things to the form. The first is worth telling the person typing — they may have
 * mistyped. The second is an installation that has not loaded the file yet, and telling every
 * user their correct PIN looks wrong would be a lie. So the lookup says which.
 */

export type PinLookup =
  | {
      ok: true;
      pincode: string;
      /** The GST code, or null where the directory's state name did not resolve. */
      stateCode: string | null;
      /** The picker's spelling when the code resolved, so it can be selected as-is. */
      stateName: string;
      city: string;
      district: string;
      /** Localities, delivery offices first — "Connaught Place", "Janpath". */
      localities: string[];
    }
  | { ok: false; reason: "invalid" | "not-found" | "no-directory" };

/** Whether any directory has been loaded — asked only once a lookup has come back empty. */
async function directoryLoaded(): Promise<boolean> {
  return (await db.postOffice.findFirst({ select: { id: true } })) !== null;
}

/** The most frequent value, first-seen on a tie. A PIN's offices almost always agree. */
function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function lookupPincode(input: string): Promise<PinLookup> {
  const pincode = String(input ?? "").replace(/\s+/g, "");
  // Six digits and nothing else. Whether it is a *valid* PIN is the form's rule (`PIN_PATTERN`);
  // this only asks the directory, and the directory has no row for a number that is not one.
  if (!/^\d{6}$/.test(pincode)) return { ok: false, reason: "invalid" };

  const offices = await db.postOffice.findMany({
    where: { pincode },
    select: { officeName: true, delivery: true, district: true, stateName: true, stateCode: true },
    orderBy: [{ delivery: "desc" }, { officeName: "asc" }],
    take: 60,
  });
  if (offices.length === 0) return { ok: false, reason: (await directoryLoaded()) ? "not-found" : "no-directory" };

  const stateCode = mostCommon(offices.map((o) => o.stateCode).filter((c): c is string => c !== null)) ?? null;
  const district = mostCommon(offices.map((o) => o.district)) ?? "";
  const names = offices.map((o) => o.officeName);

  return {
    ok: true,
    pincode,
    stateCode,
    stateName: stateCode ? GST_STATE_CODES[stateCode]! : titleCase(offices[0]!.stateName),
    city: cityForPin({ district, offices: names, stateCode }),
    district,
    localities: [...new Set(names.map(officeLocality))].slice(0, 12),
  };
}

/**
 * Cities to suggest for a state: the curated list, then every district the directory knows.
 *
 * Without a directory this is exactly `citiesIn` — the form loses nothing by the table being empty.
 */
export async function citySuggestions(state: string): Promise<string[]> {
  const name = String(state ?? "").slice(0, 80);
  const code = stateCodeFromName(name);
  const curated = citiesIn(name);
  if (!code) return curated;

  const districts = await db.postOffice.findMany({
    where: { stateCode: code },
    distinct: ["districtKey"],
    select: { district: true },
    take: 400,
  });
  return mergeCitySuggestions(curated, districts.map((d) => d.district));
}

export type PinSuggestion = { pincode: string; area: string };

/**
 * PINs in a city, for the PIN field to offer once the city is chosen.
 *
 * Matched by district *or* by an office whose name starts with the city — under every name the city
 * has had (see `pinSearchFor`), because Bengaluru's offices are published as "Bangalore …" in a
 * district called "Bengaluru Urban". One row per PIN, labelled with a delivery office where there is
 * one, since that is the name a person would recognise their street by.
 */
export async function pincodeSuggestions(state: string, city: string): Promise<PinSuggestion[]> {
  const code = stateCodeFromName(String(state ?? "").slice(0, 80));
  const place = String(city ?? "").trim().slice(0, 80);
  if (!code || place.length < 2) return [];

  const { districtKeys, officePrefixes } = pinSearchFor(place);
  const offices = await db.postOffice.findMany({
    where: {
      stateCode: code,
      OR: [
        { districtKey: { in: districtKeys } },
        ...officePrefixes.map((prefix) => ({ officeName: { startsWith: prefix, mode: "insensitive" as const } })),
      ],
    },
    select: { pincode: true, officeName: true, delivery: true },
    orderBy: [{ pincode: "asc" }, { delivery: "desc" }, { officeName: "asc" }],
    take: 1500,
  });

  const byPin = new Map<string, string>();
  for (const o of offices) if (!byPin.has(o.pincode)) byPin.set(o.pincode, officeLocality(o.officeName));
  return [...byPin.entries()].slice(0, 300).map(([pincode, area]) => ({ pincode, area }));
}

// ─── Outside India: GeoNames ──────────────────────────────────────────────────────────────────────
//
// The same arrangement as the PIN lookups above — no session, bounded inputs, capped answers — over
// GeoNames' public data (src/lib/geo/world-lookup.ts). India never reaches these: its states are the
// GST list and its postal codes India Post's.

export async function worldStates(countryCode: string): Promise<WorldState[]> {
  return statesOf(db, String(countryCode ?? "").toUpperCase().slice(0, 2));
}

export async function worldCities(countryCode: string, stateCode: string | null, typed: string): Promise<string[]> {
  return worldCitiesIn(db, String(countryCode ?? "").toUpperCase().slice(0, 2), stateCode ? String(stateCode) : null, String(typed ?? ""));
}

export async function lookupWorldPostal(countryCode: string, code: string): Promise<WorldPostalLookup> {
  return findPostal(db, String(countryCode ?? "").toUpperCase().slice(0, 2), String(code ?? "").slice(0, 20));
}
