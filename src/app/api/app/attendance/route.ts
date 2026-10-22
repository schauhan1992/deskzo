import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { clockFromPhone } from "@/lib/app/daily";
import { readReading } from "@/lib/hr/geofence";

/**
 * Clocking in or out from the Deskzo app (owner, 18 Oct 2026): `{ action: "in" | "out", latitude?, longitude?,
 * accuracy?, mocked? }` — the web's own clock-in, with where the phone was (src/lib/app/daily.ts). Where the
 * person's office checks location (owner, 22 Oct 2026) the server decides whether that is inside it; a location
 * sent that isn't a place on Earth is refused there rather than quietly dropped.
 */

export const dynamic = "force-dynamic";

const body = z.object({ action: z.enum(["in", "out"]) });

export const POST = appRoute({}, async ({ body: read, actor, device }) => {
  const input = await read();
  const { action } = body.parse(input);
  return { data: await clockFromPhone(actor.userId, device.id, action, readReading(input)) };
});
