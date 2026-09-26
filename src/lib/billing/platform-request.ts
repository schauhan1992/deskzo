import { classifyHost, requestHost } from "@/lib/tenancy/host";

/**
 * Whether a request came to the platform's own address (the bare domain, www., admin.) — where the
 * platform tick and the gateways' webhooks answer, and nowhere else: on a workspace's address they
 * are not found, so no workspace's host can be made to run the platform's chores.
 */
export function onPlatformHost(request: Request): boolean {
  const host = requestHost(request.headers);
  if (!host || typeof host !== "string") return false;
  const kind = classifyHost(host).kind;
  return kind === "root" || kind === "console";
}
