import { appRoute } from "@/lib/app/handler";
import { syncPhoneCalls } from "@/lib/app/calls";

/**
 * Call sync from the Deskzo app (owner, 18 Oct 2026): `{ calls: [{ key, number, direction, started_at,
 * duration }] }`, up to 200 at once — each answered logged, duplicate, no_match (it stays on the phone) or
 * too_old (src/lib/app/calls.ts).
 */

export const dynamic = "force-dynamic";

export const POST = appRoute({ calls: true }, async ({ body, device }) => ({ data: await syncPhoneCalls(device, await body()) }));
