"use server";

import { headers } from "next/headers";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { clientIpFrom } from "@/lib/client-ip";
import { bookSlot, publicBookingPage, type PublicBookingPage } from "@/lib/booking/server";
import type { ActionResult } from "@/actions/company";

/**
 * A booking page's own actions, for somebody with no account here: the times still open, and booking
 * one (src/lib/booking/server.ts). Open while the workspace's plan has booking pages and they are on.
 * No CAPTCHA, as the forms have none: a field a person never sees, and a page answered too fast, are
 * thanked and dropped; how many bookings one address and one page may make an hour is counted.
 */

const CLOSED = "This booking page isn't taking bookings.";

export async function bookingTimes(slug: string): Promise<PublicBookingPage | null> {
  if (!(await moduleAvailableForTenant("booking"))) return null;
  return publicBookingPage(String(slug ?? ""));
}

export async function makeBooking(
  slug: string,
  input: { start: string; name: string; email: string; phone?: string; company?: string; notes?: string; website?: string; elapsedMs?: number },
): Promise<ActionResult<{ when: string; host: string; invited: boolean; invites: boolean }>> {
  if (!(await moduleAvailableForTenant("booking"))) return { ok: false, error: CLOSED };
  const given = input && typeof input === "object" ? input : ({} as typeof input);
  // A field no person sees, filled in; or the page answered faster than anybody reads it.
  if (given.website || (typeof given.elapsedMs === "number" && given.elapsedMs < 2000)) {
    return { ok: true, data: { when: "", host: "", invited: true, invites: true } };
  }
  const source = clientIpFrom(await headers()) ?? "unknown";
  const made = await bookSlot(String(slug ?? ""), given, source);
  return made.ok ? { ok: true, data: { when: made.when, host: made.host, invited: made.invited, invites: made.invites } } : made;
}
