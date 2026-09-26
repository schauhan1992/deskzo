import { normaliseIp } from "@/lib/access/ip";

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
  if (list.length) return list.length >= hops ? normaliseIp(list[list.length - hops]) : null;
  return normaliseIp(headers.get("x-real-ip"));
}
