import { headcountLabel } from "@/lib/company-size";

/**
 * What the technical findings mean for someone about to pick up the phone.
 *
 * Wroffy sells Microsoft 365, Google Workspace, Adobe, Autodesk, security and hardware — so the
 * useful reading of a domain is "what are they running, and what does that leave open". Each
 * suggestion states the observation first, because a rep who leads with the fact ("you're on
 * Google Workspace") sounds informed, and one who leads with the pitch sounds like a cold call.
 *
 * Rules are deliberately few and specific. A screen full of maybes is one nobody reads.
 */
export type Opportunity = {
  key: string;
  /** What was observed, in the rep's words. */
  observation: string;
  /** What to do about it. */
  angle: string;
  /** How strong the signal is — "strong" means the observation is unambiguous. */
  weight: "strong" | "worth a mention";
  /** Which part of the catalogue this points at. */
  area: "Email & productivity" | "Security" | "Web & hosting" | "Licensing" | "Account";
};

export type DomainSignals = {
  emailProvider: string | null;
  emailSecurityProvider: string | null;
  spfRecord: string | null;
  dmarcRecord: string | null;
  dmarcPolicy: string | null;
  dkimFound: boolean;
  platform: string | null;
  hostProvider: string | null;
  registrar: string | null;
  expiresOn: Date | string | null;
  httpStatus: number | null;
  finalUrl: string | null;
  employeeCount: number | null;
};

const DAY = 24 * 60 * 60 * 1000;

export function opportunitiesFrom(signals: DomainSignals, asOf: Date = new Date()): Opportunity[] {
  const found: Opportunity[] = [];
  // The band, not the stored number — which may be a band's lower bound (see company-size.ts).
  const seats = headcountLabel(signals.employeeCount) ? `${headcountLabel(signals.employeeCount)} staff` : "the team";

  // ── Email and productivity ────────────────────────────────────────────────
  if (signals.emailProvider === "Google Workspace") {
    found.push({
      key: "google-to-m365",
      observation: "They run Google Workspace.",
      angle: `Worth asking what they use for documents and Teams. A Microsoft 365 comparison for ${seats} is the natural opening, and Wroffy can price both.`,
      weight: "strong",
      area: "Email & productivity",
    });
  }
  if (signals.emailProvider === "Microsoft 365") {
    found.push({
      key: "m365-upsell",
      observation: "They already run Microsoft 365.",
      angle:
        "The question is which plan. Business Basic has no desktop Office and no Intune — ask what they're on, and whether licences are bought direct or through a partner they could move to us.",
      weight: "strong",
      area: "Licensing",
    });
  }
  if (signals.emailProvider === "Self-hosted or other" || signals.emailProvider === "Shared hosting mail") {
    found.push({
      key: "legacy-mail",
      observation: "Mail appears to run on their own server or their web host.",
      angle: `Usually means no proper mailboxes, no MDM and painful backups. The clearest Microsoft 365 or Workspace migration on the list — size it for ${seats}.`,
      weight: "strong",
      area: "Email & productivity",
    });
  }
  if (signals.emailProvider === "Rediffmail Pro" || signals.emailProvider === "Zoho Mail" || signals.emailProvider === "Titan Mail") {
    found.push({
      key: "budget-mail",
      observation: `They're on ${signals.emailProvider}.`,
      angle: "A budget mail product, usually chosen on price. Ask what's missing rather than leading with cost — the gap is normally collaboration, storage or compliance.",
      weight: "worth a mention",
      area: "Email & productivity",
    });
  }

  // ── Security ──────────────────────────────────────────────────────────────
  if (!signals.spfRecord) {
    found.push({
      key: "no-spf",
      observation: "No SPF record published.",
      angle:
        "Anyone can send mail claiming to be them, and their own mail is more likely to land in spam. A short, concrete conversation that opens the door to the wider security pitch.",
      weight: "strong",
      area: "Security",
    });
  }
  if (!signals.dmarcRecord) {
    found.push({
      key: "no-dmarc",
      observation: "No DMARC record.",
      angle:
        "Nothing tells receiving servers what to do with mail that fails checks, so the domain can be spoofed in invoice fraud. Worth raising with whoever owns finance, not just IT.",
      weight: "strong",
      area: "Security",
    });
  } else if (signals.dmarcPolicy === "none") {
    found.push({
      key: "dmarc-monitor-only",
      observation: "DMARC is published but set to p=none.",
      angle:
        "They're monitoring, not enforcing — someone started this and stopped. Ask who, and offer to finish it: moving to quarantine or reject is a defined piece of work.",
      weight: "strong",
      area: "Security",
    });
  }
  if (signals.dmarcRecord && !signals.emailSecurityProvider) {
    found.push({
      key: "no-gateway",
      observation: "No mail security gateway in front of their mailboxes.",
      angle:
        "They care enough to publish DMARC but have no filtering layer. Defender for Office 365 or a gateway is a sensible next step rather than a cold pitch.",
      weight: "worth a mention",
      area: "Security",
    });
  }
  if (signals.emailSecurityProvider) {
    found.push({
      key: "existing-gateway",
      observation: `Mail is filtered through ${signals.emailSecurityProvider}.`,
      angle:
        "They buy security already, which means budget and someone who owns it. Find out when the contract renews — that's the date worth putting in the calendar.",
      weight: "strong",
      area: "Security",
    });
  }

  // ── Web and hosting ───────────────────────────────────────────────────────
  if (signals.platform === "WordPress") {
    found.push({
      key: "wordpress",
      observation: "The site runs WordPress.",
      angle:
        "Usually maintained by a freelancer or nobody. Ask who patches it and where backups go — managed hosting, backup and endpoint protection all follow from the answer.",
      weight: "worth a mention",
      area: "Web & hosting",
    });
  }
  if (signals.platform === "GoDaddy Website Builder" || signals.platform === "Wix" || signals.platform === "Squarespace") {
    found.push({
      key: "diy-site",
      observation: `The site is built on ${signals.platform}.`,
      angle:
        "A do-it-yourself site usually means no IT partner at all. That's a greenfield account — start with email and devices rather than the website.",
      weight: "worth a mention",
      area: "Account",
    });
  }
  if (signals.httpStatus && signals.httpStatus >= 400) {
    found.push({
      key: "site-down",
      observation: `Their website returned HTTP ${signals.httpStatus}.`,
      angle: "Either it's broken or it has moved. Worth mentioning early in the call — it's a genuine favour and it gets you past the gatekeeper.",
      weight: "strong",
      area: "Web & hosting",
    });
  }
  if (signals.finalUrl && signals.finalUrl.startsWith("http://")) {
    found.push({
      key: "no-https",
      observation: "The site is served over plain HTTP.",
      angle: "No certificate, so browsers mark it 'Not secure'. A small, visible problem that makes the broader security conversation concrete.",
      weight: "strong",
      area: "Security",
    });
  }

  // ── Account timing ────────────────────────────────────────────────────────
  if (signals.expiresOn) {
    const days = Math.round((new Date(signals.expiresOn).getTime() - asOf.getTime()) / DAY);
    if (days >= 0 && days <= 90) {
      found.push({
        key: "domain-expiring",
        observation: `Their domain expires in ${days} day${days === 1 ? "" : "s"}.`,
        angle:
          "Renewal time is when someone reviews what else is on that invoice. A good moment to ask who manages the domain, mail and hosting — often three different suppliers.",
        weight: "strong",
        area: "Account",
      });
    }
  }

  return found;
}

/** Strong signals first — a rep reads the top two and stops. */
export function rankOpportunities(items: Opportunity[]) {
  return [...items].sort((a, b) => (a.weight === b.weight ? 0 : a.weight === "strong" ? -1 : 1));
}
