import type { Prisma, PrismaClient } from "@deskzo/reference-client";
import { outwardKey, plainText, postalKey } from "@/lib/geo/geonames";

/**
 * Questions about places outside India, answered from GeoNames' tables in the shared reference
 * database (geo_states, geo_cities, geo_postal_codes). The queries take their client, so a check can
 * run them inside a transaction it rolls back; the address forms reach them through src/actions/geo.ts.
 *
 * Every input is bounded before it reaches a query and every answer is capped, because the actions
 * behind them run without a session (the public new-joiner form collects an address too).
 */

type Client = PrismaClient | Prisma.TransactionClient;

const COUNTRY = /^[A-Z]{2}$/;

export type WorldState = { code: string; name: string };

export async function statesOf(client: Client, countryCode: string): Promise<WorldState[]> {
  if (!COUNTRY.test(countryCode) || countryCode === "IN") return [];
  return client.geoState.findMany({
    where: { countryCode },
    orderBy: { name: "asc" },
    select: { code: true, name: true },
    take: 400,
  });
}

/**
 * Towns to suggest: the biggest first, in the state when one is chosen, starting with what has been
 * typed when anything has. Matched on the plain-letters name too, so "Zurich" finds "Zürich".
 */
export async function citiesIn(client: Client, countryCode: string, stateCode: string | null, typed: string): Promise<string[]> {
  if (!COUNTRY.test(countryCode) || countryCode === "IN") return [];
  const prefix = typed.trim().slice(0, 60);
  const rows = await client.geoCity.findMany({
    where: {
      countryCode,
      ...(stateCode ? { stateCode: stateCode.slice(0, 20) } : {}),
      ...(prefix
        ? {
            OR: [
              { name: { startsWith: prefix, mode: "insensitive" as const } },
              { asciiName: { startsWith: prefix, mode: "insensitive" as const } },
              { plainName: { startsWith: plainText(prefix), mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { population: "desc" },
    select: { name: true },
    take: 25,
  });
  return [...new Set(rows.map((r) => r.name))];
}

export type WorldPostalLookup =
  | {
      ok: true;
      postalCode: string;
      /** The state as geo_states names it, when the code matched one. */
      stateName: string | null;
      stateCode: string | null;
      /** The likeliest town — the place most rows for this code name. */
      city: string;
      /** Every place the code covers, most likely first. */
      places: string[];
      /** Only the first part of the code was matched ("SW1A"), so the town is the area's. */
      partial: boolean;
    }
  | { ok: false; reason: "invalid" | "not-found" | "no-data" };

function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export async function findPostal(client: Client, countryCode: string, code: string): Promise<WorldPostalLookup> {
  const key = postalKey(code);
  if (!COUNTRY.test(countryCode) || countryCode === "IN" || key.length < 2 || key.length > 12 || !/^[A-Z0-9]+$/.test(key)) {
    return { ok: false, reason: "invalid" };
  }
  const select = { postalCode: true, placeName: true, stateName: true, stateCode: true } as const;
  let rows = await client.geoPostalCode.findMany({ where: { countryCode, postalKey: key }, select, take: 60 });
  let partial = false;
  // A full code where only the short form was published: match the area instead.
  const outward = outwardKey(countryCode, code);
  if (rows.length === 0 && outward) {
    rows = await client.geoPostalCode.findMany({ where: { countryCode, postalKey: outward }, select, take: 60 });
    partial = rows.length > 0;
  }
  if (rows.length === 0) {
    const any = await client.geoPostalCode.findFirst({ where: { countryCode }, select: { id: true } });
    return { ok: false, reason: any ? "not-found" : "no-data" };
  }

  const places = [...new Set(rows.map((r) => r.placeName))];
  const stateCode = mostCommon(rows.map((r) => r.stateCode).filter((s): s is string => !!s)) ?? null;
  // The state's name as the picker spells it, so it can be selected as-is.
  const state = stateCode ? await client.geoState.findUnique({ where: { countryCode_code: { countryCode, code: stateCode } }, select: { name: true } }) : null;
  return {
    ok: true,
    postalCode: rows[0].postalCode,
    stateName: state?.name ?? mostCommon(rows.map((r) => r.stateName).filter((s): s is string => !!s)) ?? null,
    stateCode,
    city: mostCommon(rows.map((r) => r.placeName)) ?? places[0],
    places: places.slice(0, 12),
    partial,
  };
}
