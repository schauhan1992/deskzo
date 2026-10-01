import { randomBytes } from "node:crypto";
import { HOST_MISMATCH, classifyHost, protocolFor, requestHost } from "@/lib/tenancy/host";
import { keysFor } from "@/lib/tenancy/keys";
import { tenantForKind } from "@/lib/tenancy/registry";
import { currentTenant, explicitTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The part of the sign-in setup that makes a session belong to one workspace — shared by the full
 * configuration (src/lib/auth.ts) and the proxy's (src/lib/auth-edge.ts), which must agree on it
 * exactly or nobody stays signed in.
 *
 *   · The session token is encrypted with the workspace's own session secret (its key bundle,
 *     src/lib/tenancy/keys.ts). A cookie carried from one workspace to another does not decrypt.
 *   · It also names the workspace (`tid`), checked again wherever a session is read — a second lock
 *     on the same door, for the day somebody gets the first one wrong.
 *   · The cookie is `__Host-deskzo.session` over https: bound to the exact host, never sent to a
 *     sibling subdomain, never settable by one. Plain `deskzo.session` over http, in development.
 *   · The address is the request's own (`trustHost`), which the proxy has already checked names a
 *     workspace; there is no NEXTAUTH_URL, because there is no one address.
 */

export const SESSION_COOKIE_SECURE = "__Host-deskzo.session";
export const SESSION_COOKIE_PLAIN = "deskzo.session";

/** A secret no session was ever issued under — for a request that reaches no workspace. */
const NO_WORKSPACE_SECRET = randomBytes(32).toString("base64");

async function workspaceFor(req?: Request): Promise<{ tenant: Tenant | null; host: string | null }> {
  const explicit = explicitTenant();
  if (explicit) return { tenant: explicit, host: null };
  if (req) {
    const host = requestHost(req.headers);
    if (!host || host === HOST_MISMATCH) return { tenant: null, host: null };
    return { tenant: await tenantForKind(classifyHost(host)), host };
  }
  return { tenant: await currentTenant(), host: null };
}

export async function sessionOptions(req?: Request) {
  const { tenant, host } = await workspaceFor(req);
  const secure = host ? protocolFor(host) === "https" : tenant ? (await tenantOrigin(tenant)).startsWith("https:") : true;
  return {
    tenantId: tenant?.id ?? null,
    options: {
      secret: tenant ? (await keysFor(tenant)).sessionSecret : NO_WORKSPACE_SECRET,
      trustHost: true,
      session: { strategy: "jwt" as const },
      cookies: {
        sessionToken: {
          name: secure ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN,
          options: { httpOnly: true, sameSite: "lax" as const, path: "/", secure },
        },
      },
    },
  };
}
