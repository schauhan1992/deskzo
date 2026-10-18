import { appRoute } from "@/lib/app/handler";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The Deskzo app's "who am I" (owner, 18 Oct 2026): the person, the workspace, this phone, and what the
 * app may offer them — so a phone signed out, waiting for approval or without Calls is told so at once.
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, device }) => {
  const tenant = await currentTenantOrNull();
  return {
    data: {
      person: { id: actor.userId, name: actor.name, email: actor.email },
      workspace: { name: tenant?.name ?? null },
      phone: { id: device.id, name: device.model ?? device.platform, platform: device.platform, call_sync: device.callSync },
      can: { calls: (await moduleAccessFor(actor.userId, "calls")) === "available" },
    },
  };
});
