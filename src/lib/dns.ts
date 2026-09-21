import { Resolver } from "node:dns/promises";

/**
 * Public DNS, queried against public resolvers rather than the machine's own.
 *
 * `dns.resolveMx` and friends use whatever c-ares was handed at startup, which on a developer
 * laptop is often a local stub (127.0.0.1) and in a container is often nothing at all — both give
 * ECONNREFUSED for every lookup, which reads as "this domain publishes no MX" and is badly wrong.
 * Everything looked up here is a customer's public domain, so public resolvers are the correct
 * answer anyway. Override with `DNS_RESOLVERS` on a network that requires its own.
 *
 * Shared by Domain Intel and email verification: both draw the same conclusions from the same
 * records, and both would be silently wrong if this were configured twice.
 */
export const resolver = new Resolver();
resolver.setServers(
  (process.env.DNS_RESOLVERS ?? "1.1.1.1,8.8.8.8")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Long enough for a slow Indian host on a first hit, short enough that the button doesn't hang. */
export const DNS_TIMEOUT_MS = 5_000;

export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    // A domain with no MX, no TXT, or no A record throws rather than returning empty — which is
    // information, not an error, so every caller treats it as "nothing published".
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
