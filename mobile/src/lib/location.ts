import * as Location from "expo-location";

/**
 * Where the phone is, for clocking in or out (owner, 18 Oct 2026) — asked only then, only while the app is open,
 * never in the background. Null when the person says no, location is off, or the phone can't tell within a few
 * seconds: clocking in never waits on it.
 */
export type Place = { latitude: number; longitude: number; accuracy: number | null };

const place = (p: Location.LocationObject): Place => ({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null });

export async function whereAmI(): Promise<Place | null> {
  try {
    const { granted } = await Location.requestForegroundPermissionsAsync();
    if (!granted) return null;
    // One fix from what the phone has on — never Google's "improve accuracy" prompt on top of Android's own
    // question. High, not Balanced: Balanced needs network location, which many phones have off, and is then
    // refused outright; GPS needs only location on, and one fix costs nothing.
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
