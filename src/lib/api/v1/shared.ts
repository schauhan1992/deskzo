import { ApiError } from "@/lib/api/handler";
import { moduleAccessFor } from "@/lib/modules-access";

/**
 * A module the call needs, open to the key's person: in the plan, switched on, and theirs to open —
 * the rule the sidebar and every module page follow (src/lib/navigation.ts `decideModuleAccess`). The
 * module first, as check:module-guards reads it.
 */
export async function needModule(key: string, userId: string, name: string): Promise<void> {
  const access = await moduleAccessFor(userId, key);
  if (access === "available") return;
  const why =
    access === "not-entitled" ? `${name} isn't in this workspace's plan.` : access === "switched-off" ? `${name} is switched off in this workspace.` : `The key's person can't open ${name}.`;
  throw new ApiError(403, "module_unavailable", why);
}
