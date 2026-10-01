import { DNS_TIMEOUT_MS, resolver, withTimeout } from "@/lib/dns";
import {
  dmarcPolicyFrom,
  dnsProviderFromNs,
  emailProviderFromMx,
  emailSecurityFromMx,
  emailSecurityFromSpf,
  hostFrom,
  platformFrom,
  trimDescription,
} from "@/lib/domain-intel/signatures";

/**
 * The lookups themselves.
 *
 * Every one of these reaches outside: public DNS, the company's own homepage, and RDAP for
 * registrar details. They're therefore slow, occasionally rude to the far end, and allowed to fail
 * — so each is individually timed out, each failure is swallowed into a null, and the whole thing
 * only ever runs when someone presses Refresh. Nothing here runs on page load.
 *
 * Node's own resolver is used rather than a paid intelligence API: MX, NS and TXT are public
 * records, and reading them is what any mail server does anyway.
 */

/** A browser-ish agent: some hosts serve a different page, or none at all, to unknown clients. */
const USER_AGENT =
  "Mozilla/5.0 (compatible; DeskzoOne/1.0; +https://deskzo.com) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

const HTTP_TIMEOUT_MS = 8_000;

export type DnsFindings = {
  mxHosts: string[];
  nsHosts: string[];
  ipAddress: string | null;
  cnames: string[];
  spfRecord: string | null;
  dmarcRecord: string | null;
  dkimFound: boolean;
};

/** Selectors used by the providers this business actually meets. */
const DKIM_SELECTORS = ["google", "selector1", "selector2", "default", "zoho", "k1", "s1", "mail"];

export async function lookupDns(domain: string): Promise<DnsFindings> {
  const [mx, ns, addresses, cname, txt, dmarcTxt] = await Promise.all([
    withTimeout(resolver.resolveMx(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveNs(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolve4(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveCname(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveTxt(domain), DNS_TIMEOUT_MS),
    withTimeout(resolver.resolveTxt(`_dmarc.${domain}`), DNS_TIMEOUT_MS),
  ]);

  // TXT records arrive split into 255-character chunks; joining is required before matching.
  const flatten = (records: string[][] | null) => (records ?? []).map((parts) => parts.join(""));
  const txtRecords = flatten(txt);

  const dkimFound = (
    await Promise.all(
      DKIM_SELECTORS.map((selector) =>
        withTimeout(resolver.resolveTxt(`${selector}._domainkey.${domain}`), DNS_TIMEOUT_MS).then((r) => !!r?.length),
      ),
    )
  ).some(Boolean);

  return {
    mxHosts: (mx ?? []).sort((a, b) => a.priority - b.priority).map((r) => r.exchange),
    nsHosts: ns ?? [],
    ipAddress: addresses?.[0] ?? null,
    cnames: cname ?? [],
    spfRecord: txtRecords.find((r) => r.toLowerCase().startsWith("v=spf1")) ?? null,
    dmarcRecord: flatten(dmarcTxt).find((r) => r.toLowerCase().startsWith("v=dmarc1")) ?? null,
    dkimFound,
  };
}

export type SiteFindings = {
  finalUrl: string | null;
  httpStatus: number | null;
  siteTitle: string | null;
  siteDescription: string | null;
  platform: string | null;
  platformEvidence: string | null;
  hostProvider: string | null;
  hostEvidence: string | null;
};

/** Reads the homepage the way a browser would, and only the first 200KB of it. */
export async function lookupSite(domain: string, cnames: string[]): Promise<SiteFindings> {
  const empty: SiteFindings = {
    finalUrl: null,
    httpStatus: null,
    siteTitle: null,
    siteDescription: null,
    platform: null,
    platformEvidence: null,
    hostProvider: null,
    hostEvidence: null,
  };

  // HTTPS first; a site that only answers on HTTP is itself a finding, so the fallback is kept.
  for (const url of [`https://${domain}`, `http://${domain}`]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      });

      const html = (await response.text()).slice(0, 200_000);
      const platform = platformFrom(html, response.headers);
      const host = hostFrom(response.headers, cnames);

      return {
        finalUrl: response.url || url,
        httpStatus: response.status,
        siteTitle: trimDescription(matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i), 160),
        siteDescription: trimDescription(
          matchOne(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
            matchOne(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i),
        ),
        platform: platform?.platform ?? null,
        platformEvidence: platform?.evidence ?? null,
        hostProvider: host?.provider ?? null,
        hostEvidence: host?.evidence ?? null,
      };
    } catch {
      // Try the next scheme; if both fail the site is unreachable from here, which is reported as
      // "no response" rather than as an error on the profile.
    } finally {
      clearTimeout(timer);
    }
  }
  return empty;
}

export type RegistrationFindings = {
  registrar: string | null;
  registeredOn: Date | null;
  expiresOn: Date | null;
};

/**
 * Registrar and dates via RDAP — the registries' own successor to WHOIS.
 *
 * Free, no key, and returns JSON. Not every registry answers for every TLD (`.in` is patchy), so a
 * miss here is normal and leaves the fields blank rather than failing the refresh.
 */
export async function lookupRegistration(domain: string): Promise<RegistrationFindings> {
  const empty: RegistrationFindings = { registrar: null, registeredOn: null, expiresOn: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      signal: controller.signal,
      headers: { accept: "application/rdap+json", "user-agent": USER_AGENT },
    });
    if (!response.ok) return empty;
    const data = (await response.json()) as {
      entities?: { roles?: string[]; vcardArray?: unknown[] }[];
      events?: { eventAction?: string; eventDate?: string }[];
    };

    const registrarEntity = data.entities?.find((e) => e.roles?.includes("registrar"));
    // vCard is an awkward nested array; the full name sits in an entry tagged "fn".
    const vcard = registrarEntity?.vcardArray?.[1] as unknown[] | undefined;
    const fn = Array.isArray(vcard)
      ? (vcard.find((entry) => Array.isArray(entry) && entry[0] === "fn") as unknown[] | undefined)
      : undefined;

    const eventDate = (action: string) => {
      const value = data.events?.find((e) => e.eventAction === action)?.eventDate;
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? null : date;
    };

    return {
      registrar: typeof fn?.[3] === "string" ? (fn[3] as string) : null,
      registeredOn: eventDate("registration"),
      expiresOn: eventDate("expiration"),
    };
  } catch {
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A thumbnail of the live site.
 *
 * Defaults to WordPress's free mShots renderer, which needs no key and no account. Override with
 * `DOMAIN_SCREENSHOT_URL` (using `{url}` as the placeholder) to point at a paid service. Nothing is
 * downloaded or stored — the URL is saved and the browser fetches the image.
 */
export function screenshotUrlFor(target: string | null): string | null {
  if (!target) return null;
  const template = process.env.DOMAIN_SCREENSHOT_URL;
  if (template) return template.replace("{url}", encodeURIComponent(target));
  return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(target)}?w=640&h=400`;
}

/** Runs every lookup and folds the answers into the shape the profile stores. */
export async function inspectDomain(domain: string) {
  const dnsFindings = await lookupDns(domain);
  const [site, registration] = await Promise.all([
    lookupSite(domain, dnsFindings.cnames),
    lookupRegistration(domain),
  ]);

  return {
    ...dnsFindings,
    ...site,
    ...registration,
    emailProvider: emailProviderFromMx(dnsFindings.mxHosts),
    // A gateway shows in the MX for inbound mail and in SPF for outbound; either is enough to say so.
    emailSecurityProvider:
      emailSecurityFromMx(dnsFindings.mxHosts) ?? emailSecurityFromSpf(dnsFindings.spfRecord),
    dnsProvider: dnsProviderFromNs(dnsFindings.nsHosts),
    dmarcPolicy: dmarcPolicyFrom(dnsFindings.dmarcRecord),
    screenshotUrl: screenshotUrlFor(site.finalUrl ?? `https://${domain}`),
  };
}

function matchOne(html: string, pattern: RegExp) {
  const match = pattern.exec(html);
  return match ? match[1] : null;
}
