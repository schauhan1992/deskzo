/**
 * Which workspace a request is for, from the host it arrived on — and only from that.
 *
 *   acme.<PLATFORM_DOMAIN>      the workspace "acme"
 *   admin.<PLATFORM_DOMAIN>     the platform console
 *   cms.<PLATFORM_DOMAIN>       the public website's CMS (its own accounts — src/lib/cms)
 *   partners.<PLATFORM_DOMAIN>  the partner portal (its own accounts — src/lib/partners)
 *   <PLATFORM_DOMAIN>           the public site and signup
 *   anything else               a workspace's custom domain, or an address kept alive from before
 *                               (TENANCY_LEGACY_HOSTS) — looked up in the registry
 *
 * ## The forwarded host is a claim
 *
 * `X-Forwarded-Host` is a header anybody can send. Behind a reverse proxy that overwrites it it is
 * the truth, and the plain Host is the proxy's own internal address; anywhere else it is a request
 * to be believed. So it is weighed only when TRUST_PROXY=1 says the edge sets it. Without that, a
 * forwarded host naming a *different* workspace from the real one is an attempt to be answered as
 * another customer, and is refused outright (421) rather than quietly ignored — code that read the
 * header directly would otherwise have been fooled. Behind the proxy too, the two naming different
 * workspaces is refused: the proxy did not write that header. This file is the only one allowed to
 * read it (check:tenancy).
 */
import { PLATFORM_HOSTS, SLUG_PATTERN } from "@/lib/workspace-names";

export const PLATFORM_DOMAIN = (process.env.PLATFORM_DOMAIN ?? "localhost").trim().toLowerCase().replace(/\.$/, "");

/**
 * The platform's own addresses — subdomains it answers on itself, or will: never served as a
 * workspace (`classifyHost`), never given to one, never released by staff. The list is written in
 * src/lib/workspace-names.ts, beside the other name lists, so the name rules there stay client-safe;
 * this file is what makes it law for requests.
 *
 * Only these. The words staff may release — official-sounding ones, the products' (books., crm.) —
 * are refused for *new* workspaces by those rules, but once released, or held for a customer on an
 * invitation, such a workspace must be served like any other; and our own name is not here at all,
 * since the platform's own first workspace is called "deskzo".
 */
export { PLATFORM_HOSTS, SLUG_PATTERN };

/** The old name of PLATFORM_HOSTS, still imported by scripts (platform-adopt) and the checks. */
export const RESERVED_SLUGS = PLATFORM_HOSTS;

export type HostKind =
  | { kind: "tenant"; slug: string; host: string }
  | { kind: "console"; host: string }
  /** The website CMS: its own sign-in, no workspace, no /api. */
  | { kind: "cms"; host: string }
  /** The partner portal: its own sign-in, no workspace, no /api. */
  | { kind: "partners"; host: string }
  | { kind: "root"; host: string }
  /** Not under the platform domain: a custom domain or a kept-alive address, for the registry. */
  | { kind: "other"; host: string }
  | { kind: "invalid"; host: string };

export function normaliseHost(raw: string | null | undefined): string | null {
  const host = (raw ?? "").split(",")[0].trim().toLowerCase().replace(/\.(?=:|$)/, "");
  if (!host || host.length > 255 || !/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return null;
  return host;
}

const hostnameOf = (host: string) => host.replace(/:\d+$/, "");

/** Addresses from before workspaces existed, which keep reaching the first one. */
export function legacyHosts(): string[] {
  return (process.env.TENANCY_LEGACY_HOSTS ?? "")
    .split(",")
    .map((h) => normaliseHost(h))
    .filter((h): h is string => !!h);
}

export function classifyHost(host: string): HostKind {
  if (legacyHosts().includes(host)) return { kind: "other", host };
  const name = hostnameOf(host);
  if (name === PLATFORM_DOMAIN) return { kind: "root", host };
  const suffix = `.${PLATFORM_DOMAIN}`;
  if (!name.endsWith(suffix)) return { kind: "other", host };
  const sub = name.slice(0, -suffix.length);
  if (sub === "admin") return { kind: "console", host };
  if (sub === "cms") return { kind: "cms", host };
  if (sub === "partners") return { kind: "partners", host };
  // The public site answers on www. as well as the bare domain (unless TENANCY_LEGACY_HOSTS gives the
  // bare address to a workspace from before).
  if (sub === "www") return { kind: "root", host };
  if (sub.includes(".") || PLATFORM_HOSTS.has(sub) || !SLUG_PATTERN.test(sub)) return { kind: "invalid", host };
  return { kind: "tenant", slug: sub, host };
}

export const HOST_MISMATCH = Symbol("host-mismatch");

/**
 * The host a request is really for. `null` when there is none worth trusting; HOST_MISMATCH when an
 * untrusted forwarded host names somewhere else than the real one.
 */
export function requestHost(headers: Headers): string | null | typeof HOST_MISMATCH {
  const host = normaliseHost(headers.get("host"));
  const forwarded = normaliseHost(headers.get("x-forwarded-host"));
  if (process.env.TRUST_PROXY === "1") {
    // Behind the proxy the plain Host is its own upstream address, or the same host passed on. Both
    // naming *different* places on the platform means the forwarded one was not the proxy's — one that
    // passes a caller's header through (AWS's load balancer sets none of its own) — so it is refused
    // as without a proxy. A custom domain cannot be told from an upstream name, so it is believed.
    if (forwarded && host && forwarded !== host) {
      const a = classifyHost(forwarded);
      const b = classifyHost(host);
      if (onPlatform(a) && onPlatform(b) && !sameSite(a, b)) return HOST_MISMATCH;
    }
    return forwarded ?? host;
  }
  if (forwarded && host && forwarded !== host) {
    if (!sameSite(classifyHost(forwarded), classifyHost(host))) return HOST_MISMATCH;
  }
  return host;
}

const onPlatform = (h: HostKind) => h.kind === "tenant" || h.kind === "console" || h.kind === "cms" || h.kind === "partners" || h.kind === "root";
const sameSite = (a: HostKind, b: HostKind) => a.kind === b.kind && (a.kind !== "tenant" || (b.kind === "tenant" && a.slug === b.slug));

/**
 * http for local development hosts, https everywhere else. Outside production a `.test` name is one
 * too: it is how a custom domain is tried locally (erp.acme.test — a name under `.localhost` would be
 * read as a platform subdomain here, see src/lib/platform/domain-rules.ts), and over plain http its
 * session cookie must not be marked Secure or the browser drops it.
 */
export function protocolFor(host: string): "http" | "https" {
  const name = hostnameOf(host);
  if (name.endsWith(".test") && process.env.NODE_ENV !== "production") return "http";
  return name === "localhost" || name.endsWith(".localhost") || /^\d+\.\d+\.\d+\.\d+$/.test(name) ? "http" : "https";
}
