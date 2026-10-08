import { notFound } from "next/navigation";
import { moduleAccess } from "@/actions/module";
import { isModuleEntitled } from "@/lib/modules-access";
import { getModuleDefinition } from "@/lib/modules";

/**
 * What a page shows in place of a module that isn't available to the viewer.
 *
 * "Not available" has three causes. A module the viewer's role can't see (its view permission, or
 * its section unticked) is the 404 page, the same as any address the app doesn't have (owner, 8 Oct
 * 2026): naming the permission told people what existed behind a door they couldn't open. A module
 * switched off for the whole company, or outside the plan, is said in place — those aren't about
 * the viewer, and somebody has to know to switch it on or upgrade.
 */
export async function ModuleDisabledNotice({ moduleKey }: { moduleKey: string }) {
  const mod = getModuleDefinition(moduleKey);
  const access = await moduleAccess(moduleKey);
  if (access === "no-permission") notFound();
  if (access === "not-entitled") return <NotInPlanNotice title={mod?.label ?? "Module"} />;
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">{mod?.label ?? "Module"}</h1>
      <p className="mt-2 text-sm text-muted">
        This module is currently disabled. Ask an admin to enable it under Settings.
      </p>
    </div>
  );
}

/**
 * A module the workspace's plan doesn't include. Nobody inside can switch it on — only a change of
 * plan does, which is the owner's to ask for.
 */
export function NotInPlanNotice({ title }: { title: string }) {
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        {title} isn&apos;t part of this workspace&apos;s plan. To add it, ask the workspace owner to upgrade the plan.
      </p>
    </div>
  );
}

/**
 * For a page that configures a module rather than showing it (the portal's settings, document
 * numbering): the notice when the plan includes none of these modules, or null to carry on. Asked
 * before anything is fetched — the module's own actions would refuse.
 */
export async function planGate(modules: string | readonly string[], title: string) {
  const keys = typeof modules === "string" ? [modules] : modules;
  for (const key of keys) if (await isModuleEntitled(key)) return null;
  return <NotInPlanNotice title={title} />;
}
