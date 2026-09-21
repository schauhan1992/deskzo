import { DNS_TIMEOUT_MS, resolver, withTimeout } from "@/lib/dns";
import { emailProviderFromMx } from "@/lib/domain-intel/signatures";
import {
  isDisposableDomain,
  isFreeMailbox,
  isRoleAddress,
  parseEmailAddress,
  type EmailCheckOutcome,
} from "@/lib/email-verification";

/**
 * The half of email verification that reaches the network.
 *
 * Kept apart from the rules themselves because those are shared with the browser — the badge on a
 * contact row decides what to draw from a stored result — and importing `node:dns` into a client
 * component takes the whole build down. The classification lives in `email-verification.ts`; only
 * this file talks to a resolver, and only server actions import it.
 */

/**
 * MX for a domain, with a short-lived in-process cache.
 *
 * Verifying a company's contacts one after another asks about the same domain every time, and a
 * campaign of two hundred rows would otherwise be two hundred identical DNS queries. Mail routing
 * changes on the order of years, so a few hours of staleness costs nothing.
 */
const MX_TTL_MS = 6 * 60 * 60 * 1000;
const mxCache = new Map<string, { hosts: string[]; hasAddress: boolean; at: number }>();

export async function mailHostsFor(domain: string): Promise<{ hosts: string[]; hasAddress: boolean }> {
  const cached = mxCache.get(domain);
  if (cached && Date.now() - cached.at < MX_TTL_MS) return { hosts: cached.hosts, hasAddress: cached.hasAddress };

  const mx = await withTimeout(resolver.resolveMx(domain), DNS_TIMEOUT_MS);
  const hosts = (mx ?? []).sort((a, b) => a.priority - b.priority).map((r) => r.exchange.toLowerCase());

  // A domain with no MX but with an A record is still a valid mail destination under RFC 5321 —
  // the sender falls back to the address record. Rare now, but common enough on small Indian
  // hosting packages that treating it as undeliverable would wrongly condemn real addresses.
  const hasAddress = hosts.length > 0 ? true : (await withTimeout(resolver.resolve4(domain), DNS_TIMEOUT_MS))?.length ? true : false;

  mxCache.set(domain, { hosts, hasAddress, at: Date.now() });
  return { hosts, hasAddress };
}

/** Lets a caller seed the cache from a domain profile that already looked this up. */
export function primeMailHosts(domain: string, hosts: string[]) {
  if (hosts.length === 0) return;
  mxCache.set(domain, { hosts: hosts.map((h) => h.toLowerCase()), hasAddress: true, at: Date.now() });
}

/**
 * The full check. Reaches DNS, so it only ever runs when somebody asks for it.
 */
export async function checkEmailAddress(raw: string | null | undefined): Promise<EmailCheckOutcome> {
  const parsed = parseEmailAddress(raw);
  if (!parsed) {
    return { status: "INVALID", detail: "Not a valid email address — check it for a typo or a stray space." };
  }

  const { local, domain } = parsed;

  if (isDisposableDomain(domain)) {
    return { status: "INVALID", detail: `${domain} is a throwaway address service. Nobody reads it.` };
  }

  const { hosts, hasAddress } = await mailHostsFor(domain);

  if (hosts.length === 0 && !hasAddress) {
    return {
      status: "INVALID",
      detail: `${domain} publishes no mail server and does not resolve — mail to it will bounce.`,
    };
  }

  // `emailProviderFromMx` names an unrecognised host "Self-hosted or other", which reads as
  // nonsense in a sentence — fall back to the hostname itself, which is at least a fact.
  const provider = emailProviderFromMx(hosts);
  const named = provider && provider !== "Self-hosted or other" ? provider : null;
  const where = hosts.length === 0
    ? `${domain} has no MX and would fall back to its web server`
    : named
      ? `${named} accepts mail for ${domain}`
      : `${domain} accepts mail at ${hosts[0]}`;

  if (isRoleAddress(local)) {
    return { status: "RISKY", detail: `${where}, but ${local}@ is a shared inbox, not a person.` };
  }
  if (isFreeMailbox(domain)) {
    return { status: "RISKY", detail: `A personal ${domain} mailbox, not a company address.` };
  }

  return { status: "VALID", detail: `${where}. The mailbox itself can only be confirmed by a reply.` };
}

