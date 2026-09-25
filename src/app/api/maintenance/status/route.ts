import { NextResponse } from "next/server";
import { currentMaintenance } from "@/lib/maintenance";

/**
 * Whether the app is down for maintenance — polled by the maintenance page so it can put people
 * back by itself. See src/lib/maintenance.ts.
 *
 * Open to anybody, signed in or not: the page asking is shown to people the app is refusing, and
 * the answer is one yes-or-no they are already looking at. Under `/api`, which the proxy never
 * holds, so it answers while everything else is held.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const state = await currentMaintenance();
  return NextResponse.json({ down: state.phase === "on" }, { headers: { "cache-control": "no-store" } });
}
