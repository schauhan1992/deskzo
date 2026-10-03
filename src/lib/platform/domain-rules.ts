import { domainToASCII } from "node:url";
import { PLATFORM_DOMAIN } from "@/lib/tenancy/host";
import type { Clock } from "@/lib/time/zone";

/**
 * Custom domains — the rules, with nothing read and nothing written, so a check can test each of them
 * alone (src/lib/platform/domains.ts does the reading, the asking of DNS, and the writing).
 *
 *   · what an address the owner types becomes, and what is refused, in plain words;
 *   · the two records that prove and point it: a TXT record at `_domain-verify.<host>` whose value is
 *     `domain-verify=<token>`, and the host itself pointed at the workspace's own subdomain;
 *   · what the answers DNS gave mean — and that in development, for `.localhost` and `.test`, DNS is
 *     not asked at all, so the flow can be tried without a domain (never in production);
 *   · how a check moves an address on: waiting → live; live → failing → stopped after 72 hours of
 *     failing; stopped → live again as soon as a check passes;
 *   · how each state is said to the owner.
 *
 * Brand-neutral throughout: the record's name and value name no product, so they survive a rename.
 */

/** A change refused for a reason worth telling whoever asked — the owner, or staff. */
export class DomainRefused extends Error {}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long a live address may fail its checks before it stops being served. */
export const DOMAIN_GRACE_MS = 72 * HOUR;
/** An address nobody proved is removed after this long. */
export const PENDING_EXPIRY_MS = 14 * DAY;
/** "Check now" at most this often, per address. */
export const CHECK_EVERY_MS = 30_000;
/** Each DNS question gets this long. */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000;

export const VERIFY_LABEL = "_domain-verify";
export const VERIFY_VALUE_PREFIX = "domain-verify=";

export type DomainStatusKey = "PENDING" | "ACTIVE" | "BROKEN";

// ─── The address ─────────────────────────────────────────────────────────────────────────────────

/** What the rules depend on — the environment by default; a check passes its own. */
export type HostRules = { production: boolean; platformDomain: string };
export const hostRules = (): HostRules => ({ production: process.env.NODE_ENV === "production", platformDomain: PLATFORM_DOMAIN });

export type NormalisedHost = { ok: true; host: string; hostname: string; apex: boolean } | { ok: false; error: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Names that only mean something on a private network (or are reserved for examples and tests). */
const PRIVATE_SUFFIXES = ["localhost", "local", "internal", "test", "example", "invalid", "home.arpa"];

/** The host without its port. */
export const hostnameOf = (host: string) => host.replace(/:\d+$/, "");

/**
 * What the owner typed, as the address it is stored under: "https://ERP.Acme.com/path" becomes
 * "erp.acme.com", an international name its ASCII form. Refused, in words: an IP address, a single
 * word, a part over 63 characters or a whole over 253, the platform's own domain and anything under
 * it; and in production a port, and names that only work on a private network.
 */
export function normaliseHost(input: unknown, rules: HostRules = hostRules()): NormalisedHost {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) return { ok: false, error: "Type the address — for example erp.yourcompany.com." };
  if (typed.length > 2000) return { ok: false, error: "That address is too long — at most 253 characters." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(typed) ? typed : `http://${typed}`);
  } catch {
    return { ok: false, error: "That isn't a web address. Type just its name, like erp.yourcompany.com." };
  }
  const raw = url.hostname.replace(/\.$/, "");
  if (raw.startsWith("[") || IPV4.test(raw)) return { ok: false, error: "An IP address can't be used — type a name, like erp.yourcompany.com." };
  const hostname = domainToASCII(raw);
  if (!hostname) return { ok: false, error: "That isn't a web address. Type just its name, like erp.yourcompany.com." };
  if (hostname.length > 253) return { ok: false, error: "That address is too long — at most 253 characters." };
  const platform = rules.platformDomain;
  if (hostname === platform || hostname.endsWith(`.${platform}`)) {
    return { ok: false, error: `Addresses ending in ${platform} are the platform's own — your workspace already has one. Use an address on a domain of yours.` };
  }
  const labels = hostname.split(".");
  if (labels.length < 2) return { ok: false, error: `Type the whole address, with its ending — like ${hostname}.yourcompany.com, not just ${hostname}.` };
  if (labels.some((l) => l.length > 63)) return { ok: false, error: "Each part of an address between the dots is at most 63 characters." };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, error: "An address has only letters, digits, hyphens and dots in it — like erp.yourcompany.com." };
  if (/^\d+$/.test(labels.at(-1)!)) return { ok: false, error: "An IP address can't be used — type a name, like erp.yourcompany.com." };

  if (rules.production && PRIVATE_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))) {
    return { ok: false, error: "That address only works on a private network. Use one on a domain of yours on the internet." };
  }
  const port = url.port;
  if (port && rules.production) return { ok: false, error: "Leave out the port — the colon and the number after it." };
  return { ok: true, host: port ? `${hostname}:${port}` : hostname, hostname, apex: isApex(hostname) };
}

/** Endings under which a company's own domain is the third part from the right: acme.co.in, acme.co.uk. */
const TWO_PART_SUFFIXES = new Set([
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in", "ac.in", "edu.in", "res.in", "gov.in",
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz",
  "com.sg", "com.my", "co.id", "com.ph", "com.vn", "co.th", "com.hk", "com.tw", "com.cn",
  "com.pk", "com.bd", "com.np", "com.lk", "co.ke", "co.za", "com.ng", "com.eg", "com.sa", "com.qa", "com.kw", "com.om", "com.bh",
  "co.jp", "co.kr", "com.br", "com.mx", "com.ar", "com.co", "com.tr",
]);

/**
 * A bare domain (acme.com, acme.co.in) rather than a name under one. Many DNS providers cannot point
 * one with a CNAME, so the page warns and suggests a subdomain.
 */
export function isApex(hostname: string): boolean {
  const labels = hostnameOf(hostname).split(".");
  if (labels.length === 2) return true;
  return labels.length === 3 && TWO_PART_SUFFIXES.has(labels.slice(1).join("."));
}

// ─── The records ─────────────────────────────────────────────────────────────────────────────────

export const verifyRecordName = (host: string) => `${VERIFY_LABEL}.${hostnameOf(host)}`;
export const verifyRecordValue = (token: string) => `${VERIFY_VALUE_PREFIX}${token}`;
/** Where the address is pointed: the workspace's own subdomain, without a port. */
export const routingTarget = (slug: string, platformDomain: string = PLATFORM_DOMAIN) => `${slug}.${platformDomain}`;

export type DomainRecord = { type: "TXT" | "CNAME"; name: string; value: string };

/** The records to create, in the order to create them. Without a token (an address added before checks existed) only the pointer. */
export function domainRecords(host: string, token: string | null, target: string): DomainRecord[] {
  const records: DomainRecord[] = [];
  if (token) records.push({ type: "TXT", name: verifyRecordName(host), value: verifyRecordValue(token) });
  records.push({ type: "CNAME", name: hostnameOf(host), value: target });
  return records;
}

/**
 * In development an address under `.localhost` or `.test` is not looked up: its records count as
 * found, so adding one and seeing it go live can be tried without owning a domain. Never in
 * production, whatever the address.
 */
export function dnsSkipped(host: string, production: boolean): boolean {
  if (production) return false;
  const name = hostnameOf(host);
  return name.endsWith(".localhost") || name.endsWith(".test");
}

// ─── What DNS said ───────────────────────────────────────────────────────────────────────────────

/** One question's answer: what was found, nothing there, or no answer at all (a timeout, a failing server). */
export type Lookup = { found: string[] } | { missing: true } | { failed: string };

export type Lookups = {
  /** The TXT record's values, each record's strings joined. Absent when there is no token to look for. */
  txt?: Lookup;
  cname: Lookup;
  /** The address's own A and AAAA records, and the target's — asked only when the CNAME is not the target. */
  a?: Lookup;
  aaaa?: Lookup;
  targetA?: Lookup;
  targetAaaa?: Lookup;
};

export type RecordCheck = { txtOk: boolean; routeOk: boolean; problems: string[] };

const clean = (name: string) => name.trim().toLowerCase().replace(/\.$/, "");
const foundOf = (l: Lookup | undefined): string[] => (l && "found" in l ? l.found : []);
const failedOf = (l: Lookup | undefined): string | null => (l && "failed" in l ? l.failed : null);

/** Whether the CNAME is the target. */
export const cnameMatches = (cname: Lookup, target: string) => foundOf(cname).some((c) => clean(c) === clean(target));

/**
 * The verdict on what DNS said, with every problem in words for the owner: the TXT record has the
 * token; and the host's CNAME is the target, or (a bare domain, flattened or pointed with an ALIAS)
 * every address it has is one of the target's.
 */
export function judgeRecords(host: string, token: string | null, target: string, lookups: Lookups): RecordCheck {
  const hostname = hostnameOf(host);
  const problems: string[] = [];

  let txtOk = true;
  if (token) {
    const name = verifyRecordName(hostname);
    const values = foundOf(lookups.txt).map((v) => v.trim());
    txtOk = values.includes(verifyRecordValue(token));
    if (!txtOk) {
      const failed = failedOf(lookups.txt);
      if (failed) problems.push(`The TXT record at ${name} could not be looked up (${failed}) — try again in a minute`);
      else if (values.length) problems.push(`The TXT record at ${name} does not have the value ${verifyRecordValue(token)}`);
      else problems.push(`No TXT record found at ${name}`);
    }
  }

  const cnames = foundOf(lookups.cname).map(clean);
  let routeOk = cnames.includes(clean(target));
  if (!routeOk) {
    const own = [...foundOf(lookups.a), ...foundOf(lookups.aaaa)];
    const theirs = new Set([...foundOf(lookups.targetA), ...foundOf(lookups.targetAaaa)]);
    routeOk = cnames.length === 0 && own.length > 0 && own.every((ip) => theirs.has(ip));
    if (!routeOk) {
      const failed = failedOf(lookups.cname) ?? failedOf(lookups.a);
      if (cnames.length) problems.push(`${hostname} points to ${cnames.join(", ")}, not ${target}`);
      else if (own.length) problems.push(`${hostname} points to ${own.join(", ")}, not ${target}`);
      else if (failed) problems.push(`${hostname} could not be looked up (${failed}) — try again in a minute`);
      else problems.push(`No CNAME record found at ${hostname} — point it at ${target}`);
    }
  }
  return { txtOk, routeOk, problems };
}

/** What a failed check keeps, one problem a line. */
export const problemsText = (problems: string[]) => (problems.length ? problems.join("\n").slice(0, 2000) : "The records could not be checked.");

// ─── How a check moves an address on ─────────────────────────────────────────────────────────────

/**
 *   verified         waiting → live
 *   waiting          still waiting
 *   live             live, and still checking out
 *   failing-started  live, and its records have just stopped checking out
 *   failing          live, still failing, within the grace
 *   stopped          failing longer than the grace: no longer served
 *   still-stopped    stopped, still failing
 *   recovered        failing or stopped, and checking out again
 */
export type CheckOutcome = "verified" | "waiting" | "live" | "failing-started" | "failing" | "stopped" | "still-stopped" | "recovered";

export type DomainState = { status: DomainStatusKey; failingSince: Date | null };

export function nextDomainState(state: DomainState, passed: boolean, now: Date): DomainState & { outcome: CheckOutcome } {
  switch (state.status) {
    case "PENDING":
      return passed ? { status: "ACTIVE", failingSince: null, outcome: "verified" } : { status: "PENDING", failingSince: null, outcome: "waiting" };
    case "BROKEN":
      return passed ? { status: "ACTIVE", failingSince: null, outcome: "recovered" } : { status: "BROKEN", failingSince: state.failingSince ?? now, outcome: "still-stopped" };
    case "ACTIVE": {
      if (passed) return { status: "ACTIVE", failingSince: null, outcome: state.failingSince ? "recovered" : "live" };
      const since = state.failingSince ?? now;
      if (now.getTime() - since.getTime() >= DOMAIN_GRACE_MS) return { status: "BROKEN", failingSince: since, outcome: "stopped" };
      return { status: "ACTIVE", failingSince: since, outcome: state.failingSince ? "failing" : "failing-started" };
    }
  }
}

/** When a failing address stops being served. */
export const stopsAt = (failingSince: Date) => new Date(failingSince.getTime() + DOMAIN_GRACE_MS);

/** The owner is told once when an address starts failing, and once when it stops — this says which, for its state now. */
export function mailKind(state: DomainState): "failing" | "broken" | null {
  if (state.status === "BROKEN") return "broken";
  if (state.status === "ACTIVE" && state.failingSince) return "failing";
  return null;
}

// ─── In words ────────────────────────────────────────────────────────────────────────────────────

/** How a state reads: "waiting" (amber), "live" (green), "failing" (amber), "stopped" (red). */
export type DomainTone = "waiting" | "live" | "failing" | "stopped";

/**
 *   Waiting for DNS records
 *   Live
 *   Live — records failing since 3 Oct, stops on 6 Oct
 *   Stopped — records not found
 *
 * The days are `clock`'s: the workspace's on its own pages, the console's in the console.
 */
export function domainStatusText(state: DomainState, clock: Clock): { label: string; tone: DomainTone } {
  if (state.status === "PENDING") return { label: "Waiting for DNS records", tone: "waiting" };
  if (state.status === "BROKEN") return { label: "Stopped — records not found", tone: "stopped" };
  if (state.failingSince) return { label: `Live — records failing since ${clock.dayMonth(state.failingSince)}, stops on ${clock.dayMonth(stopsAt(state.failingSince))}`, tone: "failing" };
  return { label: "Live", tone: "live" };
}

/** Whether one more may be added. Null is no limit. */
export const allowanceLeft = (limit: number | null, used: number) => limit === null || used < limit;

/** "1 of 1 used"; with none allowed, that the plan has none. */
export function allowanceText(limit: number | null, used: number): string {
  if (limit === 0) return "Your plan doesn't include a custom domain";
  if (limit === null) return used === 0 ? "Your plan has no limit on custom domains" : `${used} used — your plan has no limit`;
  return `${used} of ${limit} used`;
}

/** Why adding one more is refused, or null. */
export function allowanceRefusal(limit: number | null, used: number): string | null {
  if (allowanceLeft(limit, used)) return null;
  if (limit === 0) return "Your plan doesn't include a custom domain.";
  return `Your plan allows ${limit === 1 ? "one custom domain" : `${limit} custom domains`}, and ${used === 1 ? "one is" : `${used} are`} added already. Remove one first.`;
}

/**
 * The mail to the workspace's owner, when an address starts failing and when it stops. Its days are on
 * `clock` — the workspace's own (`clockOfTenant`), as its owner reads them. Signed with the platform's name.
 */
export function domainMail(
  kind: "failing" | "broken",
  d: { host: string; workspace: string; ownAddress: string; failingSince: Date; problems: string[]; settingsUrl: string; brand: string },
  clock: Clock,
): { subject: string; text: string } {
  const problems = d.problems.length ? d.problems.map((p) => `  · ${p}`) : ["  · The records could not be found."];
  if (kind === "failing") {
    return {
      subject: `${d.host}: its DNS records are not checking out`,
      text: [
        "Hello,",
        "",
        `The daily check of ${d.host}, an address of ${d.workspace}, did not find the DNS records it needs:`,
        "",
        ...problems,
        "",
        `It keeps working for now. Unless the records check out again by ${clock.date(stopsAt(d.failingSince))}, ${d.host} stops reaching the workspace, and links fall back to ${d.ownAddress}.`,
        "",
        `The records are listed under Settings › Domain: ${d.settingsUrl}`,
        "",
        `— ${d.brand}`,
      ].join("\n"),
    };
  }
  return {
    subject: `${d.host} has stopped reaching ${d.workspace}`,
    text: [
      "Hello,",
      "",
      `${d.host} no longer reaches ${d.workspace}: its DNS records have not checked out since ${clock.date(d.failingSince)}.`,
      "",
      ...problems,
      "",
      `Links in emails and documents use ${d.ownAddress} meanwhile, and everybody can sign in there. Once the records are back, press Check now under Settings › Domain (${d.settingsUrl}) — the address works again as soon as they check out.`,
      "",
      `— ${d.brand}`,
    ].join("\n"),
  };
}
