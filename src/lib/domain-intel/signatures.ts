/**
 * Turning raw DNS and HTML into the handful of facts a salesperson actually asks about.
 *
 * Every function here is pure — given the records, say what they mean — so the rules can be read
 * and corrected without running a lookup. The matching is deliberately conservative: saying nothing
 * is better than saying "WordPress" about a site that merely links to a WordPress blog, because a
 * rep will repeat whatever this screen tells them on a call.
 */

/** Strips a URL or bare host down to the registrable domain, lowercased. */
export function toDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^https?:\/\//, "").replace(/^www\./, "");
  value = value.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
  // A domain needs at least one dot and no spaces; anything else was never a domain.
  if (!value.includes(".") || /\s/.test(value)) return null;
  return value;
}

type Rule = { match: RegExp; name: string };

/**
 * Mail providers, read from MX hostnames.
 *
 * Order matters: a security gateway sits in front of the mailbox provider, so its MX is what the
 * world sees. Those are matched separately in `emailSecurityFromMx` and don't hide the provider.
 */
const MX_RULES: Rule[] = [
  { match: /aspmx.*\.google(mail)?\.com|googlemail\.com|google\.com$/, name: "Google Workspace" },
  { match: /\.outlook\.com$|\.protection\.outlook\.com$|mail\.protection\.outlook/, name: "Microsoft 365" },
  { match: /zoho(cloud)?\.(com|eu|in)$|zohomail/, name: "Zoho Mail" },
  { match: /rediffmailpro|rediffmail/, name: "Rediffmail Pro" },
  { match: /secureserver\.net$/, name: "GoDaddy Email" },
  { match: /yandex/, name: "Yandex Mail" },
  { match: /\.icloud\.com$|me\.com$/, name: "iCloud Mail" },
  { match: /zimbra/, name: "Zimbra" },
  { match: /amazonses|amazonaws/, name: "Amazon SES" },
  { match: /hostinger|hostgator|bluehost|siteground|cpanel|namecheap|bigrock|resellerclub/, name: "Shared hosting mail" },
  { match: /titan\.email|flockmail/, name: "Titan Mail" },
];

/** Gateways that filter mail before it reaches the mailbox. Their presence is the interesting part. */
const MX_SECURITY_RULES: Rule[] = [
  { match: /mimecast/, name: "Mimecast" },
  { match: /pphosted|proofpoint/, name: "Proofpoint" },
  { match: /barracuda(networks)?/, name: "Barracuda" },
  { match: /messagelabs|symanteccloud/, name: "Symantec / MessageLabs" },
  { match: /trendmicro|trendmicro\.eu|hes\.trendmicro/, name: "Trend Micro" },
  { match: /sophos/, name: "Sophos" },
  { match: /forcepoint|mailcontrol/, name: "Forcepoint" },
  { match: /spamexperts|antispamcloud/, name: "SpamExperts" },
  { match: /cisco|iphmx/, name: "Cisco Secure Email" },
];

export function emailProviderFromMx(mxHosts: string[]): string | null {
  const hosts = mxHosts.map((h) => h.toLowerCase());
  for (const rule of MX_RULES) {
    if (hosts.some((h) => rule.match.test(h))) return rule.name;
  }
  return hosts.length > 0 ? "Self-hosted or other" : null;
}

export function emailSecurityFromMx(mxHosts: string[]): string | null {
  const hosts = mxHosts.map((h) => h.toLowerCase());
  for (const rule of MX_SECURITY_RULES) {
    if (hosts.some((h) => rule.match.test(h))) return rule.name;
  }
  return null;
}

const NS_RULES: Rule[] = [
  { match: /cloudflare/, name: "Cloudflare" },
  { match: /awsdns/, name: "AWS Route 53" },
  { match: /azure-dns/, name: "Azure DNS" },
  { match: /domaincontrol\.com/, name: "GoDaddy" },
  { match: /bigrock|resellerclub|publicdomainregistry/, name: "BigRock / ResellerClub" },
  { match: /hostinger/, name: "Hostinger" },
  { match: /namecheap|registrar-servers/, name: "Namecheap" },
  { match: /googledomains|google\.com$/, name: "Google Domains" },
  { match: /digitalocean/, name: "DigitalOcean" },
  { match: /vercel-dns/, name: "Vercel" },
  { match: /wpengine|wordpress\.com/, name: "WordPress.com / WP Engine" },
  { match: /gandi|ovh|hetzner/, name: "European host" },
];

export function dnsProviderFromNs(nsHosts: string[]): string | null {
  const hosts = nsHosts.map((h) => h.toLowerCase());
  for (const rule of NS_RULES) {
    if (hosts.some((h) => rule.match.test(h))) return rule.name;
  }
  return hosts.length > 0 ? "Other" : null;
}

/**
 * Website platform, from the HTML the site serves and the headers it sends.
 *
 * Each rule carries the evidence so the screen can show *why* — "wp-content in the markup" is
 * checkable by a rep; "WordPress" alone is something they have to take on faith.
 */
const PLATFORM_RULES: { name: string; test: (html: string, headers: Headers) => string | null }[] = [
  {
    name: "Shopify",
    test: (html, headers) =>
      headers.get("x-shopid") ? "x-shopid header" : /cdn\.shopify\.com|Shopify\.theme/i.test(html) ? "Shopify CDN in the markup" : null,
  },
  {
    name: "WordPress",
    test: (html) =>
      /\/wp-content\//i.test(html) ? "wp-content in the markup" : /<meta name="generator" content="WordPress/i.test(html) ? "WordPress generator tag" : null,
  },
  {
    name: "Wix",
    test: (html, headers) => (headers.get("x-wix-request-id") ? "Wix request header" : /static\.wixstatic\.com/i.test(html) ? "Wix static assets" : null),
  },
  {
    name: "Squarespace",
    test: (html) => (/squarespace\.com|static1\.squarespace/i.test(html) ? "Squarespace assets" : null),
  },
  { name: "Webflow", test: (html) => (/webflow\.(com|io)|data-wf-site/i.test(html) ? "Webflow attributes" : null) },
  { name: "Drupal", test: (html) => (/\/sites\/default\/files|Drupal\.settings/i.test(html) ? "Drupal paths" : null) },
  { name: "Joomla", test: (html) => (/\/media\/jui\/|content="Joomla/i.test(html) ? "Joomla paths" : null) },
  { name: "Magento", test: (html) => (/\/static\/version|Magento_/i.test(html) ? "Magento assets" : null) },
  { name: "HubSpot CMS", test: (html) => (/hs-scripts\.com|hubspot/i.test(html) ? "HubSpot scripts" : null) },
  { name: "GoDaddy Website Builder", test: (html) => (/img1\.wsimg\.com/i.test(html) ? "GoDaddy asset host" : null) },
  { name: "Next.js", test: (html) => (/__NEXT_DATA__|\/_next\//.test(html) ? "Next.js build output" : null) },
  { name: "React (SPA)", test: (html) => (/<div id="root"><\/div>|<div id="app"><\/div>/.test(html) ? "Empty SPA mount point" : null) },
];

export function platformFrom(html: string, headers: Headers): { platform: string; evidence: string } | null {
  for (const rule of PLATFORM_RULES) {
    const evidence = rule.test(html, headers);
    if (evidence) return { platform: rule.name, evidence };
  }
  return null;
}

/** Who serves the site. Headers first — they're the most direct statement a server makes. */
export function hostFrom(headers: Headers, cnames: string[]): { provider: string; evidence: string } | null {
  const server = headers.get("server")?.toLowerCase() ?? "";
  const checks: { when: boolean; provider: string; evidence: string }[] = [
    { when: !!headers.get("cf-ray"), provider: "Cloudflare", evidence: "cf-ray header" },
    { when: !!headers.get("x-vercel-id"), provider: "Vercel", evidence: "x-vercel-id header" },
    { when: !!headers.get("x-amz-cf-id"), provider: "AWS CloudFront", evidence: "x-amz-cf-id header" },
    { when: !!headers.get("x-github-request-id"), provider: "GitHub Pages", evidence: "GitHub header" },
    { when: server.includes("netlify"), provider: "Netlify", evidence: "server header" },
    { when: server.includes("litespeed"), provider: "LiteSpeed (shared hosting)", evidence: "server header" },
    { when: server.includes("cloudflare"), provider: "Cloudflare", evidence: "server header" },
    { when: server.includes("microsoft-iis"), provider: "Windows / IIS", evidence: "server header" },
  ];
  const hit = checks.find((c) => c.when);
  if (hit) return { provider: hit.provider, evidence: hit.evidence };

  const cname = cnames.map((c) => c.toLowerCase()).join(" ");
  const cnameRules: Rule[] = [
    { match: /cloudfront\.net/, name: "AWS CloudFront" },
    { match: /azureedge|azurewebsites/, name: "Azure" },
    { match: /herokudns/, name: "Heroku" },
    { match: /wpengine/, name: "WP Engine" },
    { match: /hostinger/, name: "Hostinger" },
    { match: /shopify/, name: "Shopify" },
  ];
  for (const rule of cnameRules) {
    if (rule.match.test(cname)) return { provider: rule.name, evidence: "CNAME target" };
  }
  return server ? { provider: server, evidence: "server header" } : null;
}

/** DMARC policy as published — `p=` is the part that decides what receivers actually do. */
export function dmarcPolicyFrom(record: string | null): string | null {
  if (!record) return null;
  const match = /\bp\s*=\s*(none|quarantine|reject)\b/i.exec(record);
  return match ? match[1].toLowerCase() : null;
}

/** Security vendors also show up in SPF includes, which is a second place worth reading. */
export function emailSecurityFromSpf(spf: string | null): string | null {
  if (!spf) return null;
  const value = spf.toLowerCase();
  const rules: Rule[] = [
    { match: /mimecast/, name: "Mimecast" },
    { match: /pphosted|proofpoint/, name: "Proofpoint" },
    { match: /barracuda/, name: "Barracuda" },
    { match: /messagelabs/, name: "Symantec / MessageLabs" },
    { match: /trendmicro/, name: "Trend Micro" },
    { match: /sophos/, name: "Sophos" },
  ];
  for (const rule of rules) if (rule.match.test(value)) return rule.name;
  return null;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&ndash;": "–",
  "&mdash;": "—",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&hellip;": "…",
};

/**
 * Decodes the entities that actually turn up in a `<title>` or meta description.
 *
 * These arrive HTML-escaped, so "Software &amp; Services" would otherwise read as markup on a
 * screen a salesperson is about to quote from.
 */
export function decodeEntities(value: string) {
  return value
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|ndash|mdash|rsquo|lsquo|hellip);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

/** The first couple of sentences of a meta description, which is as much as a rep will read. */
export function trimDescription(value: string | null | undefined, maxLength = 320) {
  if (!value) return null;
  const clean = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}
