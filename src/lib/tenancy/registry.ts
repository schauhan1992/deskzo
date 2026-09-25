import { PLATFORM_DOMAIN, classifyHost, legacyHosts, type HostKind } from "@/lib/tenancy/host";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The list of workspaces, and which host reaches which.
 *
 * ## M1: static, from the environment
 *
 *   TENANCY_DEFAULT_SLUG   the first workspace — today's data, in DATABASE_URL (default "wroffy")
 *   TENANCY_DEFAULT_NAME   its display name
 *   TENANCY_LEGACY_HOSTS   addresses from before workspaces, still reaching it ("localhost:3000")
 *   TENANT_DB_<SLUG>       any further workspace's database ("TENANT_DB_ACME=postgres://…")
 *   PLATFORM_PORT          the port to put in links in development ("3000")
 *
 * M2 replaces this with the control plane's Tenant and TenantDomain tables behind the same
 * functions, so nothing that asks "which workspace is this host" changes then.
 */

const portSuffix = () => (process.env.PLATFORM_PORT ? `:${process.env.PLATFORM_PORT}` : "");
const subdomainHost = (slug: string) => `${slug}.${PLATFORM_DOMAIN}${portSuffix()}`;

export function defaultSlug(): string {
  return (process.env.TENANCY_DEFAULT_SLUG ?? "wroffy").trim().toLowerCase();
}

export function allTenants(): Tenant[] {
  const tenants: Tenant[] = [];
  const main = process.env.DATABASE_URL;
  if (main) {
    const slug = defaultSlug();
    const legacy = legacyHosts();
    tenants.push({
      id: slug,
      slug,
      name: process.env.TENANCY_DEFAULT_NAME?.trim() || slug,
      status: "ACTIVE",
      dbUrl: main,
      // Links keep going to the address people already use, until it is retired on purpose.
      primaryHost: legacy[0] ?? subdomainHost(slug),
      hosts: [subdomainHost(slug), ...legacy],
    });
  }
  for (const [key, url] of Object.entries(process.env)) {
    const m = key.match(/^TENANT_DB_([A-Z0-9_]+)$/);
    if (!m || !url) continue;
    const slug = m[1].toLowerCase().replace(/_/g, "-");
    if (tenants.some((t) => t.slug === slug)) continue;
    tenants.push({ id: slug, slug, name: slug, status: "ACTIVE", dbUrl: url, primaryHost: subdomainHost(slug), hosts: [subdomainHost(slug)] });
  }
  return tenants;
}

export function tenantBySlug(slug: string): Tenant | null {
  return allTenants().find((t) => t.slug === slug) ?? null;
}

export function tenantById(id: string): Tenant | null {
  return allTenants().find((t) => t.id === id) ?? null;
}

/** The workspace a host reaches, or null — the console and the public site are not workspaces. */
export function tenantForHost(host: string): Tenant | null {
  return tenantForKind(classifyHost(host));
}

export function tenantForKind(kind: HostKind): Tenant | null {
  if (kind.kind === "tenant") return tenantBySlug(kind.slug);
  if (kind.kind === "other") return allTenants().find((t) => t.hosts.includes(kind.host)) ?? null;
  return null;
}

/** The workspace scripts and check suites act as when nothing else says (see resolve.ts). */
export function legacyTenant(): Tenant | null {
  return tenantBySlug(defaultSlug());
}
