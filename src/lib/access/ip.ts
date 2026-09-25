/**
 * Addresses and ranges — IPv4 and IPv6, parsed, normalised and matched.
 *
 * Pure and dependency-free, because it decides who is let in: every rule is matched here, and
 * `check:access` holds it against the awkward cases — an IPv4 address arriving as `::ffff:1.2.3.4`,
 * a port glued on by a proxy, a range written with its host bits set.
 *
 * Values are BigInts so one code path serves both families.
 */

export type ParsedIp = { version: 4 | 6; value: bigint };
export type Cidr = { version: 4 | 6; network: bigint; prefix: number; text: string };

const BITS = { 4: 32, 6: 128 } as const;

function parseV4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = BigInt(0);
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << BigInt(8)) | BigInt(n);
  }
  return value;
}

function parseV6(text: string): bigint | null {
  let head = text;
  let tailV4: bigint | null = null;
  // An IPv4 address in the last 32 bits: ::ffff:1.2.3.4, 64:ff9b::1.2.3.4.
  const lastColon = head.lastIndexOf(":");
  if (head.slice(lastColon + 1).includes(".")) {
    tailV4 = parseV4(head.slice(lastColon + 1));
    if (tailV4 === null) return null;
    head = `${head.slice(0, lastColon + 1)}0:0`;
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const read = (part: string) => (part === "" ? [] : part.split(":"));
  const left = read(halves[0]!);
  const right = halves.length === 2 ? read(halves[1]!) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...right];
  let value = BigInt(0);
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << BigInt(16)) | BigInt(parseInt(group, 16));
  }
  if (tailV4 !== null) value = (value & ~BigInt(0xffffffff)) | tailV4;
  return value;
}

const V4_MAPPED_PREFIX = BigInt(0xffff) << BigInt(32);

/**
 * An address as a proxy hands it over, or null.
 *
 * Tolerates what real headers contain: surrounding spaces, `[brackets]`, a zone (`fe80::1%eth0`), and
 * a port on an IPv4 address (`203.0.113.9:51234`, which some load balancers send). An IPv4-mapped
 * IPv6 address is returned as the IPv4 address it is, so one rule for 203.0.113.9 matches both
 * spellings of it.
 */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
  if (!raw) return null;
  let text = raw.trim();
  if (!text) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) text = bracketed[1]!;
  text = text.replace(/%.*$/, "");
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(text);
  if (v4WithPort) text = v4WithPort[1]!;

  if (!text.includes(":")) {
    const v4 = parseV4(text);
    return v4 === null ? null : { version: 4, value: v4 };
  }
  const v6 = parseV6(text);
  if (v6 === null) return null;
  if (v6 >> BigInt(32) === BigInt(0xffff) && (v6 & ~BigInt(0xffffffff)) === V4_MAPPED_PREFIX) {
    return { version: 4, value: v6 & BigInt(0xffffffff) };
  }
  return { version: 6, value: v6 };
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) {
    return [BigInt(24), BigInt(16), BigInt(8), BigInt(0)].map((shift) => String((ip.value >> shift) & BigInt(0xff))).join(".");
  }
  const groups = Array.from({ length: 8 }, (_, i) => Number((ip.value >> BigInt((7 - i) * 16)) & BigInt(0xffff)));
  // The longest run of zero groups (two or more) becomes "::", the first one if there is a tie.
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/** The one spelling an address is stored and compared under. */
export function normaliseIp(raw: string | null | undefined): string | null {
  const ip = parseIp(raw);
  return ip ? formatIp(ip) : null;
}

function mask(version: 4 | 6, prefix: number): bigint {
  const bits = BITS[version];
  if (prefix === 0) return BigInt(0);
  return ((BigInt(1) << BigInt(bits)) - BigInt(1)) ^ ((BigInt(1) << BigInt(bits - prefix)) - BigInt(1));
}

/**
 * `203.0.113.0/24`, `2401:4900::/32`, or a single address (which becomes /32 or /128).
 *
 * Host bits are cleared rather than refused — `192.168.1.7/24` is what somebody types when they
 * mean their office network — and the canonical form is what gets stored, so the list shows what
 * the rule actually covers.
 */
export function parseCidr(raw: string): Cidr | null {
  const text = raw.trim();
  const [addressPart, prefixPart, ...rest] = text.split("/");
  if (rest.length > 0 || !addressPart) return null;
  const ip = parseIp(addressPart);
  if (!ip) return null;
  const bits = BITS[ip.version];
  let prefix: number = bits;
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    // A prefix written against the IPv6 spelling of a mapped IPv4 address counts from the IPv6 end.
    if (ip.version === 4 && addressPart.includes(":")) prefix -= 96;
    if (prefix < 0 || prefix > bits) return null;
  }
  const network = ip.value & mask(ip.version, prefix);
  return { version: ip.version, network, prefix, text: `${formatIp({ version: ip.version, value: network })}/${prefix}` };
}

export function cidrContains(cidr: Cidr, ip: ParsedIp): boolean {
  return cidr.version === ip.version && (ip.value & mask(ip.version, cidr.prefix)) === cidr.network;
}

/** How many addresses a range covers, for the "this is the whole internet" warning. */
export function cidrSize(cidr: Cidr): bigint {
  return BigInt(1) << BigInt(BITS[cidr.version] - cidr.prefix);
}

const PRIVATE_RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "169.254.0.0/16",
  // Carrier-grade NAT: an address inside an ISP, not a place.
  "100.64.0.0/10",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
].map((r) => parseCidr(r)!);

/**
 * Not a place on the internet: the office LAN, the machine itself, a carrier's internal range.
 * Still matched by rules like any other address — "192.168.0.0/16 is the office" is a real rule
 * for an app hosted in the office — but never looked up in the location database.
 */
export function isPrivateIp(ip: ParsedIp): boolean {
  return PRIVATE_RANGES.some((range) => cidrContains(range, ip));
}
