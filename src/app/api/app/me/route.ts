import { appScreenRules } from "@/lib/app/dlp";
import { appRoute } from "@/lib/app/handler";
import { appModulesFor } from "@/lib/app/sales";
import { moduleAccessFor } from "@/lib/modules-access";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The Deskzo app's "who am I" (owner, 18 Oct 2026): the person, the workspace, this phone, and what the
 * app may offer them — Calls, attendance and leave (HR), Tasks, Chat, and since 22 Oct Leads, Companies and
 * Contacts, with the web's menu for the More tab — so a phone signed out, waiting for approval or without one of
 * them is told so at once — and the workspace's screen rules for them: the screenshot allowance and the
 * watermark (src/lib/app/dlp.ts).
 */

export const dynamic = "force-dynamic";

export const GET = appRoute({}, async ({ actor, device }) => {
  const tenant = await currentTenantOrNull();
  const [calls, attendance, tasks, chat, leads, companies, contacts] = await Promise.all(
    ["calls", "hr", "tasks", "chat", "leads", "companies", "contacts_library"].map(async (key) => (await moduleAccessFor(actor.userId, key)) === "available"),
  );
  return {
    data: {
      person: { id: actor.userId, name: actor.name, email: actor.email },
      workspace: { name: tenant?.name ?? null },
      phone: { id: device.id, name: device.model ?? device.platform, platform: device.platform, call_sync: device.callSync },
      can: { calls, attendance, tasks, chat, leads, companies, contacts },
      // The More tab: everything the person may open, as the web's menu lists it (src/lib/app/sales.ts).
      modules: await appModulesFor(actor.userId),
      screen: await appScreenRules({ id: actor.userId, name: actor.name, email: actor.email, role: actor.role }),
    },
  };
});
