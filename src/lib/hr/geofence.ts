import type { AttendanceExceptionReason, AttendanceExceptionScope } from "@prisma/client";
import { haversineKm } from "@/lib/access/decide";

/**
 * Whether a clocking happened at the office (owner, 22 Oct 2026) — the server's rule, the only one that counts;
 * the phone and the browser just send what they read. Pure: src/lib/hr/clock.ts applies it, and
 * check:geo-attendance holds it to its distances.
 *
 * The accuracy policy. A phone reports where it thinks it is and how sure it is (its accuracy, in metres — the
 * radius it is 68% sure the real place lies within). A reading is only taken as proof of being at the office when
 *   · it says how sure it is — a reading with no accuracy is refused, as an unknown;
 *   · it is at least as sure as the office's limit (50 m to start, set per office) — a vaguer one is refused
 *     with "try again in the open", never quietly accepted; and
 *   · its point is within the office's radius (100 m to start).
 * The radius is never widened by the accuracy: a reading 120 m out with ±40 m is outside a 100 m office, even
 * though the person may be inside. The trade-off is deliberate — a vague reading can't stretch the office to
 * cover the car park next door — and the cost is a "try again" now and then indoors, where GPS is weakest, with
 * an exception for the days it won't settle.
 *
 * What it can't do: a location is what the phone says, and a phone can be made to say anything (a mock-location
 * app, a tampered build). The server's check stops anybody stretching the rule from the phone; it doesn't prove
 * somebody is physically there. A reading the phone itself marks as mocked is refused; stronger signals (device
 * integrity, the office's Wi-Fi) slot in beside `checkGeofence` as further refusals, without changing its shape.
 */

export const DEFAULT_RADIUS_M = 100;
export const DEFAULT_MAX_ACCURACY_M = 50;
export const RADIUS_LIMITS = { min: 10, max: 5000 } as const;
export const ACCURACY_LIMITS = { min: 5, max: 1000 } as const;

export type Point = { latitude: number; longitude: number };
export type Reading = Point & { accuracy: number | null; mocked?: boolean | null };
export type Office = Point & { radiusM: number; maxAccuracyM: number };

/** Metres between two points, by the haversine formula on a sphere of the Earth's mean radius. */
export function distanceMetres(a: Point, b: Point): number {
  return haversineKm({ lat: a.latitude, lng: a.longitude }, { lat: b.latitude, lng: b.longitude }) * 1000;
}

export function validLatitude(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= -90 && n <= 90;
}

export function validLongitude(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= -180 && n <= 180;
}

/** Why a reading can't count — each a code the app and the web show their own words for. */
export type GeofenceProblem =
  | "location_required"
  | "invalid_location"
  | "accuracy_unknown"
  | "accuracy_low"
  | "mock_location"
  | "outside_office";

export type GeofenceOutcome = { ok: true; distanceM: number } | { ok: false; problem: GeofenceProblem; distanceM?: number };

/** The reading against the office: inside, or why not. */
export function checkGeofence(office: Office, reading: Reading | null): GeofenceOutcome {
  if (!reading) return { ok: false, problem: "location_required" };
  if (!validLatitude(reading.latitude) || !validLongitude(reading.longitude)) return { ok: false, problem: "invalid_location" };
  if (reading.mocked === true) return { ok: false, problem: "mock_location" };
  const distanceM = Math.round(distanceMetres(office, reading));
  if (reading.accuracy === null || !Number.isFinite(reading.accuracy) || reading.accuracy < 0) return { ok: false, problem: "accuracy_unknown", distanceM };
  if (reading.accuracy > office.maxAccuracyM) return { ok: false, problem: "accuracy_low", distanceM };
  if (distanceM > office.radiusM) return { ok: false, problem: "outside_office", distanceM };
  return { ok: true, distanceM };
}

/**
 * What a phone or browser sent, read strictly: nothing sent is `null`; something sent that isn't a place on Earth
 * is "invalid" — never quietly treated as no location. Accuracy is rounded to whole metres; one that isn't a
 * number, or is negative, is unknown.
 */
export function readReading(body: Record<string, unknown> | null | undefined): Reading | null | "invalid" {
  if (!body) return null;
  const sent = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (!sent(body.latitude) && !sent(body.longitude)) return null;
  const latitude = Number(body.latitude);
  const longitude = Number(body.longitude);
  if (!sent(body.latitude) || !sent(body.longitude) || !validLatitude(latitude) || !validLongitude(longitude)) return "invalid";
  const raw = Number(body.accuracy);
  const accuracy = sent(body.accuracy) && Number.isFinite(raw) && raw >= 0 ? Math.min(100_000, Math.round(raw)) : null;
  return { latitude, longitude, accuracy, mocked: body.mocked === true ? true : body.mocked === false ? false : null };
}

export type OfficeLocationInput = {
  latitude?: unknown;
  longitude?: unknown;
  radiusM?: unknown;
  maxAccuracyM?: unknown;
  enforced?: unknown;
  exceptionsAllowed?: unknown;
};

export type OfficeLocation = {
  latitude: number | null;
  longitude: number | null;
  geofenceRadiusM: number;
  geoMaxAccuracyM: number;
  geofenceEnforced: boolean;
  geoExceptionsAllowed: boolean;
};

const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));

/** An office's attendance location as an administrator typed it, or what is wrong with it. */
export function readOfficeLocation(input: OfficeLocationInput): { ok: true; value: OfficeLocation } | { ok: false; error: string } {
  const latitude = num(input.latitude);
  const longitude = num(input.longitude);
  if ((latitude === null) !== (longitude === null)) return { ok: false, error: "Give both the latitude and the longitude, or neither." };
  if (latitude !== null && !validLatitude(latitude)) return { ok: false, error: "Latitude is between -90 and 90." };
  if (longitude !== null && !validLongitude(longitude)) return { ok: false, error: "Longitude is between -180 and 180." };
  const radius = num(input.radiusM) ?? DEFAULT_RADIUS_M;
  if (!Number.isInteger(radius) || radius < RADIUS_LIMITS.min || radius > RADIUS_LIMITS.max) {
    return { ok: false, error: `The radius is a whole number of metres, ${RADIUS_LIMITS.min} to ${RADIUS_LIMITS.max}.` };
  }
  const accuracy = num(input.maxAccuracyM) ?? DEFAULT_MAX_ACCURACY_M;
  if (!Number.isInteger(accuracy) || accuracy < ACCURACY_LIMITS.min || accuracy > ACCURACY_LIMITS.max) {
    return { ok: false, error: `The accuracy limit is a whole number of metres, ${ACCURACY_LIMITS.min} to ${ACCURACY_LIMITS.max}.` };
  }
  const enforced = input.enforced === true;
  if (enforced && latitude === null) return { ok: false, error: "Set the office's location before turning on GPS attendance — otherwise nobody could clock in." };
  return {
    ok: true,
    value: { latitude, longitude, geofenceRadiusM: radius, geoMaxAccuracyM: accuracy, geofenceEnforced: enforced, geoExceptionsAllowed: input.exceptionsAllowed !== false },
  };
}

/** What each refusal says to the person clocking — plain words, nothing about the office's coordinates. */
export const PROBLEM_WORDS: Record<GeofenceProblem | "office_not_configured" | "exception_needed", string> = {
  location_required: "Your location is needed to clock in or out at your office. Please allow location and try again.",
  invalid_location: "Your phone sent a location that isn't valid. Please try again.",
  accuracy_unknown: "Your location accuracy is unknown. Please try again in an open area.",
  accuracy_low: "Your location accuracy is insufficient. Please try again in an open area.",
  mock_location: "Your phone reports a simulated location. Turn off any location-changing app and try again.",
  outside_office: "You are outside the permitted office area.",
  office_not_configured: "Office location has not been configured. Please contact your administrator.",
  exception_needed: "Your attendance needs an approved exception.",
};

/** How an attendance exception's reason and reach read, wherever one is shown (src/actions/attendance-exceptions.ts). */
export const EXCEPTION_REASON_LABELS: Record<AttendanceExceptionReason, string> = {
  ALTERNATE_LOCATION: "Working at another location",
  GPS_UNAVAILABLE: "GPS not working",
  CORRECTION: "Attendance correction",
  OTHER: "Other",
};

export const EXCEPTION_SCOPE_LABELS: Record<AttendanceExceptionScope, string> = {
  IN: "Clock in",
  OUT: "Clock out",
  IN_AND_OUT: "Clock in and out",
};

/** Why somebody was refused, in a few words — for the approver reading their request. */
export const PROBLEM_SHORT: Record<string, string> = {
  location_required: "No location shared",
  invalid_location: "Invalid location",
  accuracy_unknown: "Accuracy unknown",
  accuracy_low: "GPS not accurate enough",
  mock_location: "Simulated location",
  outside_office: "Outside the office area",
  office_not_configured: "Office location not set",
};
