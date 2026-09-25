"use server";

import { auth, signOut } from "@/lib/auth";
import { recordLocation } from "@/lib/access/record";

/**
 * The two things a person held at the door can do: share where they are, and leave.
 *
 * The session is read directly rather than through `requireUser`, and that is the point — the gate
 * in `requireUser` refuses exactly the people this page exists for. Each action does one narrow
 * thing to the caller's own session and nothing else, which is why it is safe to leave ungated:
 * sharing a location only satisfies the location rule, and signing out only removes a session.
 * Listed in `check:rbac`'s public actions with that reason.
 */

export async function shareLocation(input: {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "You're signed out. Sign in again." };
  return recordLocation({
    userId: session.user.id,
    sid: session.user.sid ?? null,
    latitude: Number(input.latitude),
    longitude: Number(input.longitude),
    accuracyM: input.accuracy === null ? null : Number(input.accuracy),
  });
}

export async function leaveAccessPage() {
  await signOut({ redirectTo: "/login" });
}
