import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline } from "node:stream";
import zlib from "node:zlib";
import { cidrContains, parseCidr, parseIp, type ParsedIp } from "@/lib/access/ip";
import { DNS_TIMEOUT_MS, resolver, withTimeout } from "@/lib/dns";

/**
 * Fetching a URL somebody else chose, without letting it reach inside our own network.
 *
 * Domain Intel reads a customer's homepage from the website typed on the company (2026-10-17: it
 * took an IP address as a "domain", followed redirects anywhere, and so would fetch 127.0.0.1 or
 * the cloud metadata address and store what came back). Deskzo Automate's HTTP and webhook steps
 * will need the same guard. Four things make it hold:
 *
 *   · **The address is checked, not the name.** A hostname is resolved first (public DNS, as the
 *     rest of Domain Intel uses), and every address it answers with must be public — one private
 *     answer refuses the lot. A number written as a host (`2130706433`, `0x7f.1`) is normalised by
 *     the URL parser before it is checked, so those spellings don't slip past.
 *   · **The connection goes to that address.** The request's `lookup` hands back the address that
 *     was checked, so a name that answers differently a moment later (DNS rebinding) can't swap it.
 *   · **Every redirect is a new request.** Followed by hand, at most `maxRedirects`, each hop
 *     checked as the first was. One to another site drops the caller's headers that could be a
 *     credential — an API key, a bearer token — as browsers drop Authorization.
 *   · **Bounded.** One deadline for the whole chain, a cap on the bytes read, http(s) only, and
 *     only the ports the caller allows (80 and 443 unless told otherwise).
 *
 * Server-only. Throws `SafeFetchError` for anything refused or failed; callers that treat a miss as
 * "no answer" catch it, as Domain Intel does.
 */

/** Never a place on the public internet. Wider than `isPrivateIp`, which also decides sign-in rules. */
const BLOCKED_RANGES = [
  // IPv4
  "0.0.0.0/8", // "this network"
  "10.0.0.0/8",
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local, and the cloud metadata address
  "168.63.129.16/32", // Azure's host address (WireServer), reachable from every VM in Azure
  "172.16.0.0/12",
  "192.0.0.0/24", // protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // 6to4 relay
  "192.168.0.0/16",
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, and the broadcast address
  // IPv6
  "::/96", // unspecified, loopback, and IPv4-compatible addresses
  "64:ff9b::/96", // NAT64: an IPv4 address in disguise
  "64:ff9b:1::/48",
  "100::/64", // discard
  "2001::/23", // protocol assignments, Teredo among them
  "2001:db8::/32", // documentation
  "2002::/16", // 6to4: an IPv4 address in disguise
  "fc00::/7", // unique local
  "fe80::/10", // link-local
  "fec0::/10", // site-local, retired
  "ff00::/8", // multicast
].map((range) => parseCidr(range)!);

/** Whether an address must never be fetched. An IPv4-mapped IPv6 address is judged as the IPv4 it is. */
export function isBlockedAddress(ip: ParsedIp): boolean {
  return BLOCKED_RANGES.some((range) => cidrContains(range, ip));
}

export type SafeFetchErrorCode = "bad-url" | "bad-port" | "blocked-address" | "no-address" | "too-many-redirects" | "timeout" | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  /** GET when not given. A body goes with anything else. */
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: string;
  headers?: Record<string, string>;
  /** The schemes a URL may use — Automate's calls say https only. Both when not given. */
  protocols?: readonly ("http:" | "https:")[];
  /** For the whole chain, redirects included. */
  timeoutMs?: number;
  /** Bytes of body kept, after decompression; the rest is never read. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Ports a URL may name. 80 and 443 when not given. */
  ports?: readonly number[];
  /** How a hostname becomes addresses. Public DNS when not given; checks pass a stub. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Which addresses are refused. `isBlockedAddress` when not given; only checks replace it. */
  blocked?: (ip: ParsedIp) => boolean;
};

export type SafeResponse = {
  /** Where the body came from, after redirects. */
  url: string;
  status: number;
  headers: Headers;
  body: string;
  /** The body was longer than `maxBytes` and was cut there. */
  truncated: boolean;
};

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The caller's headers a redirect to another site still gets: none that could be a credential. */
const CROSS_ORIGIN_HEADERS = new Set(["user-agent", "accept", "accept-language", "content-type", "idempotency-key"]);

async function publicDnsAddresses(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    withTimeout(resolver.resolve4(hostname), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolve6(hostname), DNS_TIMEOUT_MS),
  ]);
  return [...(v4 ?? []), ...(v6 ?? [])];
}

/** The one address a URL may be fetched from, or a refusal saying why not. */
async function checkedTarget(raw: string, options: SafeFetchOptions): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("bad-url", `"${raw}" isn't a web address.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("bad-url", "Only http and https addresses can be fetched.");
  if (options.protocols && !options.protocols.includes(url.protocol as "http:" | "https:")) throw new SafeFetchError("bad-url", `Only ${options.protocols.map((p) => p.replace(":", "")).join(" or ")} addresses can be called.`);
  if (url.username || url.password) throw new SafeFetchError("bad-url", "An address with a username or password in it isn't fetched.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!(options.ports ?? [80, 443]).includes(port)) throw new SafeFetchError("bad-port", `Port ${port} isn't allowed.`);

  const blocked = options.blocked ?? isBlockedAddress;
  // The URL parser has already turned 2130706433, 0x7f.1 and 017.0.0.1 into dotted form.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    const ip = parseIp(host);
    if (!ip || blocked(ip)) throw new SafeFetchError("blocked-address", `${host} is not a public address.`);
    return { url, address: host, family: isIP(host) === 6 ? 6 : 4 };
  }

  const addresses = await (options.resolve ?? publicDnsAddresses)(host);
  if (addresses.length === 0) throw new SafeFetchError("no-address", `${host} has no address.`);
  // One private answer refuses the name: a public record beside it is no reason to trust it.
  for (const address of addresses) {
    const ip = parseIp(address);
    if (!ip || blocked(ip)) throw new SafeFetchError("blocked-address", `${host} points at ${address}, which is not a public address.`);
  }
  const chosen = addresses.find((a) => isIP(a) === 4) ?? addresses[0]!;
  return { url, address: chosen, family: isIP(chosen) === 6 ? 6 : 4 };
}

function decoded(response: http.IncomingMessage): NodeJS.ReadableStream {
  const encoding = String(response.headers["content-encoding"] ?? "").toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip" ? zlib.createGunzip() : encoding === "deflate" ? zlib.createInflate() : encoding === "br" ? zlib.createBrotliDecompress() : null;
  if (!decoder) return response;
  // pipeline, not pipe: a response cut off at the deadline ends the decoder too. Through pipe() the
  // decoder never ended, and the read waited for ever.
  pipeline(response, decoder, () => {});
  return decoder;
}

function headersOf(response: http.IncomingMessage): Headers {
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i]!, raw[i + 1]!);
    } catch {
      // A header the Fetch rules won't hold (a stray byte in a name) is left out, not fatal.
    }
  }
  return headers;
}

/** One request to one checked address; the response is handed back unread. */
function requestOnce(
  target: { url: URL; address: string; family: 4 | 6 },
  headers: Record<string, string>,
  deadline: number,
  send: { method: string; body: string | null } = { method: "GET", body: null },
): Promise<{ response: http.IncomingMessage; abort: () => void }> {
  return new Promise((resolvePromise, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SafeFetchError("timeout", "The site took too long to answer."));
    const { url, address, family } = target;
    // Hands the checked address to the socket, whatever the name would resolve to now.
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const client = url.protocol === "https:" ? https : http;
    const request = client.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: send.method,
      headers: { "accept-encoding": "gzip, deflate, br", ...headers, ...(send.body !== null ? { "content-length": String(Buffer.byteLength(send.body)) } : {}), host: url.host },
      lookup,
      // The certificate is checked against the name, not the address it was reached at.
      ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
      agent: false,
    });
    const timer = setTimeout(() => request.destroy(new SafeFetchError("timeout", "The site took too long to answer.")), remaining);
    request.on("response", (response) => {
      resolvePromise({
        response,
        abort: () => {
          clearTimeout(timer);
          request.destroy();
        },
      });
      response.on("close", () => clearTimeout(timer));
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof SafeFetchError ? error : new SafeFetchError("network", error.message));
    });
    if (send.body !== null) request.write(send.body);
    request.end();
  });
}

async function readBody(response: http.IncomingMessage, maxBytes: number, abort: () => void): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  try {
    for await (const chunk of decoded(response)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      if (size + buffer.length > maxBytes) {
        chunks.push(buffer.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(buffer);
      size += buffer.length;
    }
  } catch (error) {
    if (!truncated) throw error instanceof SafeFetchError ? error : new SafeFetchError("network", (error as Error).message);
  } finally {
    abort();
  }
  return { body: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

/**
 * A request to a URL somebody else supplied, refused if it — or any redirect — leads inside our
 * network. A redirect is followed as browsers do: 307 and 308 keep the method and body; 301, 302 and
 * 303 become a GET without one.
 */
export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeResponse> {
  const deadline = Date.now() + (options.timeoutMs ?? 8_000);
  const maxRedirects = options.maxRedirects ?? 3;
  let current = rawUrl;
  let send = { method: options.method ?? "GET", body: options.method && options.method !== "GET" ? (options.body ?? "") : null };
  let headers = options.headers ?? {};
  for (let hop = 0; ; hop += 1) {
    const target = await checkedTarget(current, options);
    const { response, abort } = await requestOnce(target, headers, deadline, send);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (REDIRECTS.has(status) && location) {
      abort();
      if (hop >= maxRedirects) throw new SafeFetchError("too-many-redirects", "The site redirected too many times.");
      if (status !== 307 && status !== 308) send = { method: "GET", body: null };
      let next: URL;
      try {
        next = new URL(location, target.url);
      } catch {
        throw new SafeFetchError("bad-url", "The site redirected to an address that isn't one.");
      }
      // Sent somewhere else, a call keeps only the headers that carry nothing secret — an API key or
      // a bearer token is for the site it was given to, not wherever that site points.
      if (next.origin !== target.url.origin) headers = Object.fromEntries(Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase())));
      current = next.toString();
      continue;
    }
    const { body, truncated } = await readBody(response, options.maxBytes ?? 1_000_000, abort);
    return { url: target.url.toString(), status, headers: headersOf(response), body, truncated };
  }
}
