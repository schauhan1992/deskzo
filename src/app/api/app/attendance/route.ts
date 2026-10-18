import { z } from "zod";
import { appRoute } from "@/lib/app/handler";
import { clockFromPhone, readLocation } from "@/lib/app/daily";

/**
 * Clocking in or out from the Deskzo app (owner, 18 Oct 2026): `{ action: "in" | "out", latitude?, longitude?,
 * accuracy? }` — the web's own clock-in, with where the phone was when it shares that (src/lib/app/daily.ts).
 */

export const dynamic = "force-dynamic";

const body = z.object({ action: z.enum(["in", "out"]) });

export const POST = appRoute({}, async ({ body: read, actor, device }) => {
  const input = await read();
  const { action } = body.parse(input);
  return { data: await clockFromPhone(actor.userId, device.id, action, readLocation(input)) };
});
