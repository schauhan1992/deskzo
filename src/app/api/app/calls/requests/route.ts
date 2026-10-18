import { appRoute } from "@/lib/app/handler";
import { takeCallRequests } from "@/lib/app/calls";

/**
 * "Ring my phone" — the calls a call dialog asked this phone to dial, each handed over once (owner,
 * 18 Oct 2026). Asked when a push arrives, and every few seconds while the app is open.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async ({ device }) => ({ data: await takeCallRequests(device.id) }));
