import * as Location from "expo-location";

/**
 * Where the phone is, for clocking in or out (owner, 18 Oct 2026) — asked only then, only while the app is open,
 * never in the background, never tracked. The server decides whether it is inside the office (owner, 22 Oct 2026;
 * src/lib/hr/clock.ts there); the phone only reads it and says, when it can't, why not.
 */
export type Place = { latitude: number; longitude: number; accuracy: number | null; mocked?: boolean | null };

/** Why the phone couldn't say where it is — each with its own words and its own way out on the Today screen. */
export type NoPlace = "permission_denied" | "permission_blocked" | "services_off" | "no_fix";

export type Located = { ok: true; place: Place } | { ok: false; reason: NoPlace };

const place = (p: Location.LocationObject): Place => ({
  latitude: p.coords.latitude,
  longitude: p.coords.longitude,
  accuracy: p.coords.accuracy ?? null,
  // Android and iOS both say when a location comes from a mock provider or a simulator.
  mocked: typeof p.mocked === "boolean" ? p.mocked : null,
});

/**
 * One reading, for an office that checks location: the permission (asked once, while the app is in use), location
 * services, then a fresh fix — or a recent one when the fresh one won't come. Never cached between taps.
 */
export async function locate(): Promise<Located> {
  try {
    let permission = await Location.getForegroundPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: permission.canAskAgain ? "permission_denied" : "permission_blocked" };
    if (!(await Location.hasServicesEnabledAsync())) return { ok: false, reason: "services_off" };
    // One fix from what the phone has on — never Google's "improve accuracy" prompt on top of Android's own
    // question. High, not Balanced: Balanced needs network location, which many phones have off, and is then
    // refused outright; GPS needs only location on, and one fix costs nothing.
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
    ]);
    // A fallback no older than two minutes: an older one could be from the way in, and say "outside" wrongly.
    const known = fix ?? (await Location.getLastKnownPositionAsync({ maxAge: 2 * 60_000 }).catch(() => null));
    return known ? { ok: true, place: place(known) } : { ok: false, reason: "no_fix" };
  } catch {
    return { ok: false, reason: "no_fix" };
  }
}

/** Where the phone is if it will say, else null — for an office that doesn't check location: clocking never waits on it. */
export async function whereAmI(): Promise<Place | null> {
  try {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) return null;
    const fix = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: false }).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    const known = fix ?? (await Location.getLastKnownPositionAsync({ maxAge: 5 * 60_000 }).catch(() => null));
    return known ? place(known) : null;
  } catch {
    return null;
  }
}

/** Asks Android to turn location on (its own dialog); false where it can't, or the person says no. */
export async function askToTurnOnLocation(): Promise<boolean> {
  try {
    await Location.enableNetworkProviderAsync();
    return Location.hasServicesEnabledAsync();
  } catch {
    return false;
  }
}
