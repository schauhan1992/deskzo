import { appRoute } from "@/lib/app/handler";
import { dueCallbacks } from "@/lib/app/calls";

/** The person's callbacks still owed, soonest first — the Deskzo app's calling list (owner, 18 Oct 2026). */

export const dynamic = "force-dynamic";

export const GET = appRoute({ calls: true }, async () => ({ data: await dueCallbacks() }));
