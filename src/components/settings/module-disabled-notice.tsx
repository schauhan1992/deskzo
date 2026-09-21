import { getModuleDefinition } from "@/lib/modules";

export function ModuleDisabledNotice({ moduleKey }: { moduleKey: string }) {
  const mod = getModuleDefinition(moduleKey);
  return (
    <div className="max-w-md">
      <h1 className="text-xl font-semibold text-text">{mod?.label ?? "Module"}</h1>
      <p className="mt-2 text-sm text-muted">
        This module is currently disabled. Ask an admin to enable it under Settings.
      </p>
    </div>
  );
}
