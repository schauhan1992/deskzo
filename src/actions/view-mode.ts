"use server";

import { cookies } from "next/headers";
import { requireUser } from "@/lib/session";
import { parseViewMode, viewModeCookie, type ViewMode, type ViewModeKey } from "@/lib/view-mode";

/** A year — this is a UI preference, not a session thing, and re-choosing it every week is noise. */
const MAX_AGE = 60 * 60 * 24 * 365;

/**
 * Read on the server so the list renders in the chosen layout on the first paint. Doing this from
 * the client would mean every list flashes the table before swapping to the split view.
 */
export async function getViewMode(key: ViewModeKey): Promise<ViewMode> {
  // A session, because every `"use server"` export is an endpoint — even one that only reads a
  // preference cookie. The bar is "nothing is reachable without an account", not "nothing
  // sensitive is".
  await requireUser();
  const store = await cookies();
  return parseViewMode(key, store.get(viewModeCookie(key))?.value);
}

export async function setViewMode(key: ViewModeKey, mode: ViewMode): Promise<void> {
  await requireUser();
  const store = await cookies();
  store.set(viewModeCookie(key), mode, {
    maxAge: MAX_AGE,
    path: "/",
    sameSite: "lax",
    // Readable by the server only — nothing on the client needs it, and it isn't a secret either way.
    httpOnly: true,
  });
}
