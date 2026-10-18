import { appScreenRules } from "@/lib/app/dlp";
import { appRoute } from "@/lib/app/handler";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The Deskzo app's "who am I" (owner, 18 Oct 2026): the person, the workspace, this phone, and what the
 * app may offer them — Calls, attendance and leave (HR), Tasks, Chat — so a phone signed out, waiting for approval
 * or without one of them is told so at once — and the workspace's screen rules for them: the screenshot allowance
 * and the watermark (src/lib/app/dlp.ts).
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, device }) => {
  const tenant = await currentTenantOrNull();
  const [calls, attendance, tasks, chat] = await Promise.all(["calls", "hr", "tasks", "chat"].map(async (key) => (await moduleAccessFor(actor.userId, key)) === "available"));
  return {
    data: {
      person: { id: actor.userId, name: actor.name, email: actor.email },
      workspace: { name: tenant?.name ?? null },
      phone: { id: device.id, name: device.model ?? device.platform, platform: device.platform, call_sync: device.callSync },
      can: { calls, attendance, tasks, chat },
      screen: await appScreenRules({ id: actor.userId, name: actor.name, email: actor.email, role: actor.role }),
    },
  };
});
