import type { PlatformEnv } from "@/lib/console-shared/types";
import { StatusPill } from "./status";

/**
 * Which installation this console is driving. Production is the danger tone on purpose: it is the
 * one where a click reaches paying customers.
 */
export function EnvBadge({ env, size = "sm" }: { env: PlatformEnv; size?: "sm" | "md" }) {
  return (
    <StatusPill tone={env.tone} dot title={`Environment: ${env.label}`} className={size === "md" ? "px-2.5 py-1 text-xs" : undefined}>
      {env.label}
    </StatusPill>
  );
}
