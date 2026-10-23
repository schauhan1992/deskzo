import { getSecret, getSetting } from "@/lib/platform/settings";

/**
 * Workspaces' own addresses on Cloudflare for SaaS (owner, 23 Oct 2026). deskzo.com's records are proxied by
 * Cloudflare, so an address on a domain outside Cloudflare (erp.acme.com, CNAMEd to acme.deskzo.com) is refused
 * by Cloudflare with its Error 1001 until it is added to the deskzo.com zone as a custom hostname — which is also
 * what gets it an HTTPS certificate. src/lib/platform/domains.ts adds one here once the address's own records
 * check out (never for an address nobody has proved), reads what Cloudflare says about it on every check, and
 * removes it with the address.
 *
 * Connected from the console (Settings › Custom domains): the zone's id (`cloudflare.zoneId`) and an API token
 * (`cloudflare.apiToken`, sealed) with Zone › SSL and Certificates › Edit on that zone. The zone's fallback
 * origin — where Cloudflare sends these addresses' requests — is set once in Cloudflare's dashboard
 * (docs/deploy-coolify.md); the console's Check connection reads it back.
 *
 * Plain fetch over Cloudflare's REST API, no SDK. Check suites replace `globalThis.fetch`.
 */

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;

/** Cloudflare couldn't be reached, or refused: `message` is Cloudflare's own, for staff. */
export class CloudflareError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

export type CloudflareConfig = { zoneId: string; token: string };

/** Both set, or nothing — an address is then checked by its DNS records alone, as before Cloudflare. */
export async function cloudflareConfig(): Promise<CloudflareConfig | null> {
  const [zoneId, token] = await Promise.all([getSetting("cloudflare.zoneId"), getSecret("cloudflare.apiToken")]);
  return zoneId?.trim() && token?.trim() ? { zoneId: zoneId.trim(), token: token.trim() } : null;
}

type Envelope<T> = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: T };

async function call<T>(cfg: CloudflareConfig, method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/zones/${encodeURIComponent(cfg.zoneId)}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new CloudflareError(`Cloudflare could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  const json = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!res.ok || !json?.success) {
    const said = json?.errors?.map((e) => e.message).filter(Boolean)[0];
    throw new CloudflareError(said ? `Cloudflare: ${said}` : `Cloudflare answered ${res.status}.`, res.status);
  }
  return json.result as T;
}

// ─── A custom hostname ───────────────────────────────────────────────────────────────────────────

/** Cloudflare's custom hostname, as much of it as is read. */
type CustomHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl?: { status?: string; validation_records?: { txt_name?: string; txt_value?: string }[]; validation_errors?: { message?: string }[] } | null;
  ownership_verification?: { type?: string; name?: string; value?: string } | null;
  verification_errors?: string[] | null;
};

export type EdgeRecord = { type: "TXT"; name: string; value: string };

/**
 * What an address's row keeps of its hostname on Cloudflare (TenantDomain.edge): Cloudflare's id, the hostname's
 * status and its certificate's, the TXT records Cloudflare asks for while either is pending, and its errors.
 */
export type EdgeState = { id: string; status: string; ssl: string | null; records: EdgeRecord[]; errors: string[] };

export function edgeState(h: CustomHostname): EdgeState {
  const ssl = h.ssl?.status ?? null;
  const records: EdgeRecord[] = [];
  const own = h.ownership_verification;
  if (h.status !== "active" && own?.type === "txt" && own.name && own.value) records.push({ type: "TXT", name: own.name, value: own.value });
  if (ssl !== "active") {
    for (const r of h.ssl?.validation_records ?? []) if (r.txt_name && r.txt_value) records.push({ type: "TXT", name: r.txt_name, value: r.txt_value });
  }
  const errors = [...(h.verification_errors ?? []), ...(h.ssl?.validation_errors ?? []).map((e) => e.message ?? "")].map((e) => e.trim()).filter(Boolean);
  return { id: h.id, status: h.status, ssl, records, errors: [...new Set(errors)].slice(0, 5) };
}

/** A row's `edge` as it was stored — anything else is none. */
export function edgeOf(value: unknown): EdgeState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<EdgeState>;
  if (typeof v.id !== "string" || typeof v.status !== "string") return null;
  const records = Array.isArray(v.records) ? v.records.filter((r): r is EdgeRecord => !!r && r.type === "TXT" && typeof r.name === "string" && typeof r.value === "string") : [];
  const errors = Array.isArray(v.errors) ? v.errors.filter((e): e is string => typeof e === "string") : [];
  return { id: v.id, status: v.status, ssl: typeof v.ssl === "string" ? v.ssl : null, records, errors };
}

/** Served over HTTPS by Cloudflare: the hostname confirmed and its certificate live. */
export const edgeReady = (e: EdgeState) => e.status === "active" && e.ssl === "active";

const DEAD_HOSTNAME = new Set(["moved", "deleted", "pending_deletion", "blocked", "pending_blocked", "test_blocked", "test_failed"]);
const DEAD_CERTIFICATE = new Set(["deleted", "pending_deletion", "expired", "inactive", "deactivating"]);

/** Not going to become ready by waiting: moved away, blocked, deleted — or its certificate timed out or lapsed. */
export const edgeFailed = (e: EdgeState) => DEAD_HOSTNAME.has(e.status) || (!!e.ssl && (DEAD_CERTIFICATE.has(e.ssl) || e.ssl.endsWith("_timed_out")));

/**
 * In words for the workspace's owner — which name no product, as the rest of Settings › Domain doesn't: nothing
 * when it is ready, why it isn't otherwise.
 */
export function edgeProblems(e: EdgeState, host: string): string[] {
  if (edgeReady(e)) return [];
  // A problem a line, without a full stop: the page lists them, and Check now joins them into one sentence.
  const extra = e.records.length ? " — if it takes longer than an hour, add the extra TXT record listed below" : "";
  if (edgeFailed(e)) {
    if (e.status === "moved") return [`${host} no longer points here, so its HTTPS certificate was stopped — point it back and check again`];
    return [`The HTTPS certificate for ${host} couldn't be issued${e.errors.length ? ` (${e.errors[0]})` : ""} — check its records, then check again`];
  }
  if (e.status !== "active") return [`${host} is being confirmed for HTTPS, usually within a few minutes of its records being in place${extra}`];
  return [`The HTTPS certificate for ${host} is being issued, usually within a few minutes — check again shortly${extra}`];
}

/** Its hostname on Cloudflare, by name — or null. */
async function findHostname(cfg: CloudflareConfig, host: string): Promise<CustomHostname | null> {
  const found = await call<CustomHostname[]>(cfg, "GET", `/custom_hostnames?hostname=${encodeURIComponent(host)}`);
  return (found ?? []).find((h) => h.hostname?.toLowerCase() === host) ?? null;
}

/** One by its id; null once it's gone. */
async function readHostname(cfg: CloudflareConfig, id: string): Promise<CustomHostname | null> {
  try {
    return await call<CustomHostname>(cfg, "GET", `/custom_hostnames/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The address's hostname on Cloudflare: the one the row knows, else one of that name (added by hand, or by a
 * workspace that was waiting on it too), else a new one — validated over HTTP, which works at once because the
 * address already points here.
 */
export async function ensureHostname(cfg: CloudflareConfig, host: string, knownId: string | null): Promise<EdgeState> {
  const known = knownId ? await readHostname(cfg, knownId) : null;
  if (known && known.hostname?.toLowerCase() === host) return edgeState(known);
  const existing = await findHostname(cfg, host);
  if (existing) return edgeState(existing);
  try {
    return edgeState(
      await call<CustomHostname>(cfg, "POST", "/custom_hostnames", { hostname: host, ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } }),
    );
  } catch (err) {
    // Added meanwhile by another check of the same address: that one is it.
    const meanwhile = err instanceof CloudflareError ? await findHostname(cfg, host).catch(() => null) : null;
    if (meanwhile) return edgeState(meanwhile);
    throw err;
  }
}

/** Gone from Cloudflare, by name. False when there was none. */
export async function deleteHostname(cfg: CloudflareConfig, host: string): Promise<boolean> {
  const found = await findHostname(cfg, host);
  if (!found) return false;
  try {
    await call<unknown>(cfg, "DELETE", `/custom_hostnames/${encodeURIComponent(found.id)}`);
  } catch (err) {
    if (err instanceof CloudflareError && err.status === 404) return false;
    throw err;
  }
  return true;
}

// ─── The connection ──────────────────────────────────────────────────────────────────────────────

export type CloudflareConnection = {
  /** Where Cloudflare sends these addresses' requests (the zone's fallback origin), and whether that is live. */
  fallbackOrigin: string | null;
  fallbackStatus: string | null;
  errors: string[];
  /** How many addresses the zone has as custom hostnames — the first 100 are free. */
  hostnames: number | null;
};

/** What the console's Check connection shows: the token and zone work, and where the addresses' requests go. */
export async function cloudflareConnection(cfg: CloudflareConfig): Promise<CloudflareConnection> {
  const fallback = await call<{ origin?: string; status?: string; errors?: string[] } | null>(cfg, "GET", "/custom_hostnames/fallback_origin").catch((err) => {
    // A zone that never had one answers 404: the token works, the origin is still to be set.
    if (err instanceof CloudflareError && err.status === 404) return null;
    throw err;
  });
  let hostnames: number | null = null;
  try {
    const res = await fetch(`${API}/zones/${encodeURIComponent(cfg.zoneId)}/custom_hostnames?per_page=5`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const json = (await res.json().catch(() => null)) as { result_info?: { total_count?: number } } | null;
    hostnames = typeof json?.result_info?.total_count === "number" ? json.result_info.total_count : null;
  } catch {
    // Only a count for the console; the fallback origin above is the answer that matters.
  }
  return { fallbackOrigin: fallback?.origin ?? null, fallbackStatus: fallback?.status ?? null, errors: fallback?.errors ?? [], hostnames };
}
