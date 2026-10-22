import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Where the phone was at a visit's check-in and check-out (owner, 22 Oct 2026 — the Deskzo app's field work): read only
 * at those two moments, and only when the phone shares it. Whoever may open the visit sees them (the caller has
 * already read the visit through its access rule — src/lib/authz/access.ts, "visits").
 */

export type VisitPlace = { kind: "IN" | "OUT"; at: string; latitude: number; longitude: number; accuracyM: number | null; mocked: boolean | null };

/** A visit's check-in and check-out places, in order — none on a workspace not migrated to them yet. */
export async function visitPlaces(visitId: string): Promise<VisitPlace[]> {
  try {
    const rows = await db.visitLocation.findMany({
      where: { visitId },
      orderBy: { at: "asc" },
      select: { kind: true, at: true, latitude: true, longitude: true, accuracyM: true, mocked: true },
    });
    return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Keeps where the phone was as it checked in or out; nothing when it shared nothing, or the workspace hasn't the table yet. */
export async function keepVisitPlace(
  visitId: string,
  kind: "IN" | "OUT",
  place: { latitude: number; longitude: number; accuracy: number | null; mocked?: boolean | null } | null,
  appDeviceId: string | null,
): Promise<boolean> {
  if (!place) return false;
  try {
    await db.visitLocation.create({
      data: {
        visitId,
        kind,
        latitude: place.latitude,
        longitude: place.longitude,
        accuracyM: place.accuracy === null ? null : Math.round(place.accuracy),
        mocked: place.mocked ?? null,
        appDeviceId,
      },
    });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** A map of the place, for a person reading it later. */
export const mapLink = (p: { latitude: number; longitude: number }) => `https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`;
