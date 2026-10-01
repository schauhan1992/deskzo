import { classifyHost } from "@/lib/tenancy/host";
import { tenantForKind } from "@/lib/tenancy/registry";

/**
 * Whether the HTTPS proxy may get a certificate for a host. The proxy (Caddy, deploy/azure/Caddyfile)
 * gets certificates on demand — the first time a name is asked for — and asks this first, through
 * /api/platform/tls-ask, so a workspace's address, or its own domain once proved, works over HTTPS
 * without anybody issuing anything by hand.
 *
 * Only what this installation serves: the platform's own addresses (the public site on the bare
 * domain and www., the console, the CMS, the partner portal), a workspace that exists, and a
 * workspace's own domain once it is verified and live. Never a stranger's domain pointed at the
 * server or a made-up subdomain: each would cost a certificate from the authority's weekly limit,
 * and anybody could ask for thousands.
 */
export async function certificateAllowed(input: string | null | undefined): Promise<boolean> {
  const host = String(input ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253 || host.includes(":") || host.includes("/")) return false;
  const kind = classifyHost(host);
  if (kind.kind === "root" || kind.kind === "console" || kind.kind === "cms" || kind.kind === "partners") return true;
  if (kind.kind !== "tenant" && kind.kind !== "other") return false;
  const tenant = await tenantForKind(kind);
  // A closed workspace's database is gone; a held or migrating one still shows its notice.
  return !!tenant && tenant.status !== "DEPROVISIONED";
}
