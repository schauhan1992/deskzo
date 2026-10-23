import { appRoute } from "@/lib/app/handler";
import { callerDirectory } from "@/lib/app/calls";

/**
 * Caller ID for an iPhone (owner, 22 Oct 2026): iOS never lets the app look a ringing number up, so the app loads
 * its Call Directory with these ahead of time and again now and then — `{ entries: [{ number, label }], truncated }`,
 * every customer's number this person may see, as caller ID would match it (src/lib/app/match.ts directoryEntries).
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async () => ({ data: await callerDirectory() }));
