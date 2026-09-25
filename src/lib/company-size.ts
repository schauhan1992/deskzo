/**
 * How big a company is — as a band, the way anybody actually knows it.
 *
 * Nobody filling in a new customer knows they have 37 staff. They know it is "11 to 50", which is
 * what LinkedIn shows and what the customer says on the phone. So the forms offer these bands.
 *
 * ## Stored as a number, on purpose
 *
 * `companies.employeeCount` stays an integer, because several things need a number: the seat-gap
 * marketing trigger subtracts licences sold from it, the workspace filters compare it with a minimum
 * and a maximum. A band picked on a form is stored as its **lower bound** — the conservative reading,
 * so a seat gap is never overstated. An exact count that came from somewhere better (an import,
 * domain intelligence) is **kept** whenever the band chosen still contains it: re-saving a company
 * with 85 staff under "51–200" leaves 85, not 51. Only choosing a different band moves it.
 *
 * Everything that shows the number shows the band (`headcountLabel`), so a stored lower bound never
 * reads as a precise "51 employees".
 */

export const EMPLOYEE_BANDS = [
  { key: "1-10", label: "1–10", min: 1, max: 10 },
  { key: "11-50", label: "11–50", min: 11, max: 50 },
  { key: "51-200", label: "51–200", min: 51, max: 200 },
  { key: "201-500", label: "201–500", min: 201, max: 500 },
  { key: "501-1000", label: "501–1,000", min: 501, max: 1000 },
  { key: "1001-5000", label: "1,001–5,000", min: 1001, max: 5000 },
  { key: "5001-10000", label: "5,001–10,000", min: 5001, max: 10000 },
  { key: "10001+", label: "10,001+", min: 10001, max: null },
] as const;

export type EmployeeBand = (typeof EMPLOYEE_BANDS)[number];
export type EmployeeBandKey = EmployeeBand["key"];

export const EMPLOYEE_BAND_KEYS = EMPLOYEE_BANDS.map((b) => b.key) as [EmployeeBandKey, ...EmployeeBandKey[]];

const within = (count: number, band: EmployeeBand) => count >= band.min && (band.max === null || count <= band.max);

/** The band a count falls in — or null for no count, or a zero left over from older data. */
export function bandForCount(count: number | null | undefined): EmployeeBand | null {
  if (count === null || count === undefined || count < 1) return null;
  return EMPLOYEE_BANDS.find((b) => within(count, b)) ?? null;
}

/** "51–200" — what to show wherever a company's size is displayed. */
export function headcountLabel(count: number | null | undefined): string | null {
  return bandForCount(count)?.label ?? null;
}

/**
 * The number to store for a band chosen on a form.
 *
 * Blank clears it. Otherwise the count already held is kept when it lies inside the chosen band —
 * it is more precise than the band — and the band's lower bound is used when it does not.
 */
export function countForBand(key: EmployeeBandKey | "" | null | undefined, current: number | null | undefined): number | null {
  if (!key) return null;
  const band = EMPLOYEE_BANDS.find((b) => b.key === key);
  if (!band) return null;
  if (current !== null && current !== undefined && within(current, band)) return current;
  return band.min;
}
