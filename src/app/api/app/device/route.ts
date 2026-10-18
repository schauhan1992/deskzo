import { z } from "zod";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { appRoute } from "@/lib/app/handler";
import { unpairPhone } from "@/lib/app/pairing";

/**
 * This phone (owner, 18 Oct 2026). PATCH: its push address, its app version, and call sync on or off — the
 * person's own say on the phone, so it is never switched on from anywhere else. DELETE: signs the phone out
 * of Deskzo, at once.
 */

export const dynamic = "force-dynamic";

const patch = z.object({
  push_token: z.string().trim().min(10).max(4096).nullable().optional(),
  app_version: z.string().trim().max(30).optional(),
  call_sync: z.boolean().optional(),
});

export const PATCH = appRoute({}, async ({ body, device, actor }) => {
  const input = patch.parse(await body());
  const updated = await db.appDevice.update({
    where: { id: device.id },
    data: {
      ...(input.push_token !== undefined ? { pushToken: input.push_token } : {}),
      ...(input.app_version !== undefined ? { appVersion: input.app_version || null } : {}),
      ...(input.call_sync !== undefined ? { callSync: input.call_sync } : {}),
    },
    select: { callSync: true, pushToken: true, appVersion: true },
  });
  if (input.call_sync !== undefined && input.call_sync !== device.callSync) {
    await recordAudit({ userId: actor.userId, action: "UPDATE", entityType: "AppDevice", entityId: device.id, entityLabel: `Call sync ${input.call_sync ? "on" : "off"}` });
  }
  return { data: { call_sync: updated.callSync, push: !!updated.pushToken, app_version: updated.appVersion } };
});

export const DELETE = appRoute({}, async ({ device, actor }) => {
  await unpairPhone(device.id, actor.userId);
  await recordAudit({ userId: actor.userId, action: "UPDATE", entityType: "AppDevice", entityId: device.id, entityLabel: "Signed out of the Deskzo app" });
  return { data: { signed_out: true } };
});
