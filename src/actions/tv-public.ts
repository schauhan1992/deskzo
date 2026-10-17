"use server";

import { collectPairing, pairingForThisTv } from "@/lib/tv/screens";
import { moduleAvailableForTenant } from "@/lib/modules-access";

/**
 * What a TV calls while it shows its code (owner, 17 Oct 2026) — no sign-in, because nobody signs in on a
 * TV. All it can do is get a code for itself and ask whether somebody has paired it; the pairing itself
 * needs "Put Deskzo on a TV" (src/actions/tv.ts). Both work only off the TV's own cookie.
 */

/** This TV's code, and when it runs out. "BUSY" while too many TVs are waiting; null where the wins board is off. */
export async function tvPairingCode(): Promise<{ code: string; expiresAt: string } | "BUSY" | null> {
  // The workspace's switch and plan — there's no person here whose permissions could be asked.
  if (!(await moduleAvailableForTenant("wins"))) return null;
  const pairing = await pairingForThisTv();
  if (!pairing) return "BUSY";
  return { code: pairing.code, expiresAt: pairing.expiresAt.toISOString() };
}

/**
 * Whether this TV has been paired — and when it has, it is from now on (its cookie is set). With the wins
 * board switched off it is told its code ran out, and asking for a new one tells it the board is off.
 */
export async function tvPairingStatus(): Promise<"PAIRED" | "WAITING" | "EXPIRED"> {
  if (!(await moduleAvailableForTenant("wins"))) return "EXPIRED";
  return collectPairing();
}
