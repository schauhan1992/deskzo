import { cidrContains, normaliseIp, parseCidr, parseIp, type Cidr } from "@/lib/access/ip";

/**
 * The address a request came from — as our own reverse proxy saw it, and only then.
 *
 * X-Forwarded-For is a list anybody can start: a caller may send `X-Forwarded-For: 10.0.0.1`, and
 * each proxy on the way appends the address it was connected from. So the first entry is a claim,
 * and only what our own proxies added can be believed — the last entry behind one proxy, or the
 * n-th from the end behind a chain of n (TRUST_PROXY_HOPS; 2 for a CDN in front of nginx). If the
 * list is shorter than that, the request did not come through them all and nothing is believed.
 * X-Real-IP, which a proxy sets rather than appends, counts only when there is no list at all.
 *
 * Behind Cloudflare (TRUST_PROXY_CLOUDFLARE=1, security review 23 Oct 2026): the address our proxy saw is a
 * Cloudflare edge, shared by everybody that edge serves — so lockouts would lock them all out together and IP rules
 * would see only Cloudflare. Cloudflare says who connected to it in CF-Connecting-IP, and that is believed only when
 * the address our proxy saw is one of Cloudflare's own: a request sent straight to the server with the header made up
 * is answered by its real address.
 *
 * Without TRUST_PROXY=1, nothing in the headers is believed and the answer is null. Next itself
 * fills X-Forwarded-For with the connection's address only when a request has none, so a caller
 * who sends one would be taken at its word. Null is the honest answer, and the code built on this
 * treats it so: IP rules match nobody (an allowlist then holds everybody, as the console's does),
 * per-caller lockouts keep only their per-account half rather than share one bucket between
 * everybody, and the activity log records no address rather than a false one.
 *
 * Plain — no next/headers — so the proxy and server code share it. The only place that reads
 * these headers (check:tenancy).
 */
export function clientIpFrom(headers: Pick<Headers, "get">): string | null {
  if (process.env.TRUST_PROXY?.trim() !== "1") return null;
  const hops = Math.max(1, Math.floor(Number(process.env.TRUST_PROXY_HOPS?.trim() || 1)) || 1);
  const list = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const peer = list.length ? (list.length >= hops ? normaliseIp(list[list.length - hops]) : null) : normaliseIp(headers.get("x-real-ip"));
  if (peer && process.env.TRUST_PROXY_CLOUDFLARE?.trim() === "1" && isCloudflare(peer)) {
    return normaliseIp(headers.get("cf-connecting-ip")) ?? peer;
  }
  return peer;
}

/**
 * Cloudflare's own addresses, as it publishes them (https://www.cloudflare.com/ips-v4 and /ips-v6, read 23 Oct 2026).
 * They change rarely; a new range missing here only means its visitors are seen as Cloudflare again, as before.
 */
const CLOUDFLARE_RANGES = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
]
  .map(parseCidr)
  .filter((cidr): cidr is Cidr => cidr !== null);

export function isCloudflare(address: string): boolean {
  const ip = parseIp(address);
  return !!ip && CLOUDFLARE_RANGES.some((cidr) => cidr.version === ip.version && cidrContains(cidr, ip));
}
