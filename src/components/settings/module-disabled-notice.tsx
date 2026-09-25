import { moduleAccess } from "@/actions/module";
import { getModuleDefinition } from "@/lib/modules";
import { getPermissionDefinition } from "@/lib/permissions";

/**
 * What a page shows in place of a module that isn't available to the viewer.
 *
 * "Not available" has two causes that call for different people: a module switched off for the
 * whole company (an admin turns it on in Settings), and a module the viewer's role can't see
 * (an admin grants the view permission). `isModuleEnabled` answers both with one `false`, so
 * this asks which it was rather than telling someone to switch on a module that is already on.
 */
export async function ModuleDisabledNotice({ moduleKey }: { moduleKey: string }) {
  const mod = getModuleDefinition(moduleKey);
  const access = await moduleAccess(moduleKey);
  if (access === "no-permission" && mod?.viewPermission) {
    return <NoAccessNotice title={mod.label} permission={mod.viewPermission} />;
  }
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">{mod?.label ?? "Module"}</h1>
      <p className="mt-2 text-sm text-muted">
        This module is currently disabled. Ask an admin to enable it under Settings.
      </p>
    </div>
  );
}

/** A page the viewer's role doesn't include, and the permission that would let them in. */
export function NoAccessNotice({ title, permission }: { title: string; permission: string }) {
  const label = getPermissionDefinition(permission)?.label ?? permission;
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">{title}</h1>
      <p className="mt-2 text-sm text-muted">
        You don&apos;t have access to this. Ask an admin to grant you &ldquo;{label}&rdquo; under
        Users &amp; Access.
      </p>
    </div>
  );
}
