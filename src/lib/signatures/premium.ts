import {
  SIGNATURE_TEMPLATES,
  finishSignature,
  renderSignature,
  signatureDetails,
  signatureImg,
  signatureLogo,
  signatureParts,
  signatureTable,
  type SignatureDetails,
  type SignatureParts,
  type SignatureStyle,
  type SignatureTemplate,
} from "@/lib/signatures/render";

/**
 * The premium layouts — Deskzo Signatures' own, for companies that bought it; the free generator on the
 * website has the four in render.ts and never imports this file, so it can't draw these. Built from
 * the same checked, escaped parts, with the same rules: tables and inline styles, coloured boxes as
 * `bgcolor` cells (the only kind Outlook's Word engine draws), nothing a mail program strips.
 */

export const PREMIUM_TEMPLATES = [
  { key: "executive", label: "Executive", hint: "A fine rule under the name, the logo set apart" },
  { key: "corporate", label: "Corporate", hint: "The logo on a tinted panel beside the details" },
  { key: "bold", label: "Bold", hint: "Name and title on a band of colour" },
  { key: "centered", label: "Centred", hint: "Everything centred, the photo on top" },
  { key: "card", label: "Card", hint: "A bordered card with a tinted footer" },
  { key: "spotlight", label: "Spotlight", hint: "A large photo beside a thick colour bar" },
] as const;
export type PremiumTemplate = (typeof PREMIUM_TEMPLATES)[number]["key"];
export type SignatureLayout = SignatureTemplate | PremiumTemplate;

/** Every layout the paid product offers, free ones first. */
export const ALL_SIGNATURE_LAYOUTS: { key: SignatureLayout; label: string; hint: string; premium: boolean }[] = [
  ...SIGNATURE_TEMPLATES.map((t) => ({ key: t.key, label: t.label, hint: t.hint, premium: false })),
  ...PREMIUM_TEMPLATES.map((t) => ({ key: t.key, label: t.label, hint: t.hint, premium: true })),
];

/** The layouts as a template row stores them (SignatureTemplate.layout) — the free four, then the premium six. */
export const STORED_LAYOUTS = {
  CLASSIC: "classic",
  MODERN: "modern",
  STACKED: "stacked",
  COMPACT: "compact",
  EXECUTIVE: "executive",
  CORPORATE: "corporate",
  BOLD: "bold",
  CENTERED: "centered",
  CARD: "card",
  SPOTLIGHT: "spotlight",
} as const satisfies Record<string, SignatureLayout>;
export type StoredLayout = keyof typeof STORED_LAYOUTS;

const PREMIUM_KEYS = new Set<string>(PREMIUM_TEMPLATES.map((t) => t.key));

export function isPremiumLayout(key: string): key is PremiumTemplate {
  return PREMIUM_KEYS.has(key);
}

/** The colour mixed with white — `amount` 0 is the colour, 1 is white. */
export function tint(hex: string, amount: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#f3f4f6";
  const mix = (h: string) => {
    const c = parseInt(h, 16);
    return Math.round(c + (255 - c) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${mix(m[1]!)}${mix(m[2]!)}${mix(m[3]!)}`;
}

/** Up to two letters for a panel without a logo — letters and digits only, so nothing needs escaping. */
function initials(d: SignatureDetails): string {
  const words = (d.company || d.name)
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const contacts = (p: SignatureParts) => (p.lines.length ? `<div style="padding-top:6px;font-size:13px;line-height:1.6;">${p.lines.map((l) => `<div>${l}</div>`).join("")}</div>` : "");
const companyLine = (p: SignatureParts) => (p.company ? `<div style="color:${p.color};font-weight:bold;">${p.company}</div>` : "");
const centred = (inner: string) => `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto;"><tr><td align="center">${inner}</td></tr></table>`;

function premiumBody(layout: PremiumTemplate, p: SignatureParts, d: SignatureDetails): string {
  const open = signatureTable(p);
  switch (layout) {
    case "executive": {
      const rule = `<table cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 6px;"><tr><td width="44" height="2" bgcolor="${p.color}" style="background:${p.color};width:44px;height:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
      const photo = p.photo ? `<td style="padding:0 16px 0 0;vertical-align:top;">${signatureImg(p.photo, p.name, 72, 72, "round")}</td>` : "";
      const logo = p.logo ? `<td style="padding:0 0 0 20px;vertical-align:middle;"><table cellpadding="0" cellspacing="0" border="0"><tr><td style="border-left:1px solid #e5e7eb;padding:4px 0 4px 20px;">${signatureLogo(p, 110)}</td></tr></table></td>` : "";
      const main = `<td style="vertical-align:top;"><div style="font-size:20px;font-weight:bold;color:#111111;letter-spacing:0.3px;">${p.name}</div>${
        p.role ? `<div style="padding-top:2px;font-size:12px;color:#666666;text-transform:uppercase;letter-spacing:1px;">${p.role}</div>` : ""
      }${rule}${companyLine(p)}${contacts(p)}${p.social}${p.cta}</td>`;
      return `${open}<tr>${photo}${main}${logo}</tr></table>`;
    }
    case "corporate": {
      const panel = tint(p.color, 0.9);
      const mark = p.logo ? signatureLogo(p, 96) : `<div style="font-size:28px;font-weight:bold;color:${p.color};letter-spacing:1px;">${initials(d)}</div>`;
      const photo = p.photo ? `<div style="padding-bottom:8px;">${signatureImg(p.photo, p.name, 56, 56, "round")}</div>` : "";
      return `${open}<tr><td bgcolor="${panel}" width="120" align="center" style="background:${panel};border-left:4px solid ${p.color};padding:16px 14px;width:120px;text-align:center;vertical-align:middle;">${mark}</td><td style="padding:4px 0 4px 18px;vertical-align:middle;">${photo}${signatureDetails(p, 17)}${p.cta}</td></tr></table>`;
    }
    case "bold": {
      const head = `<tr><td bgcolor="${p.color}" style="background:${p.color};padding:12px 16px;border-radius:6px 6px 0 0;"><div style="font-size:18px;font-weight:bold;color:${p.ink};">${p.name}</div>${
        p.role ? `<div style="font-size:13px;color:${p.ink};">${p.role}</div>` : ""
      }</td></tr>`;
      const photo = p.photo ? `<td style="padding:0 14px 0 0;vertical-align:top;">${signatureImg(p.photo, p.name, 56, 56, "round")}</td>` : "";
      const logo = p.logo ? `<td style="padding:0 0 0 16px;vertical-align:middle;">${signatureLogo(p, 90)}</td>` : "";
      const inner = `<table cellpadding="0" cellspacing="0" border="0"><tr>${photo}<td style="vertical-align:top;">${companyLine(p)}${contacts(p)}${p.social}${p.cta}</td>${logo}</tr></table>`;
      return `${open}${head}<tr><td style="padding:12px 16px;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 6px 6px;">${inner}</td></tr></table>`;
    }
    case "centered": {
      const photo = p.photo ? `<div style="padding-bottom:8px;">${centred(signatureImg(p.photo, p.name, 76, 76, "round"))}</div>` : "";
      const role = p.role ? `<div style="color:#555555;">${p.role}</div>` : "";
      const lines = p.lines.length ? `<div style="padding-top:6px;font-size:13px;line-height:1.6;">${p.lines.join(" &nbsp;&middot;&nbsp; ")}</div>` : "";
      const logo = p.logo ? `<div style="padding-top:12px;">${centred(signatureLogo(p, 110))}</div>` : "";
      return `${open}<tr><td align="center" style="text-align:center;">${photo}<div style="font-size:18px;font-weight:bold;color:#111111;">${p.name}</div>${role}${companyLine(p)}${lines}${p.social ? centred(p.social) : ""}${p.cta ? centred(p.cta) : ""}${logo}</td></tr></table>`;
    }
    case "card": {
      const footBg = tint(p.color, 0.92);
      const side = p.photo ? `<td style="padding:0 14px 0 0;vertical-align:top;">${signatureImg(p.photo, p.name, 64, 64, "round")}</td>` : "";
      const role = p.role ? `<div style="color:#555555;">${p.role}</div>` : "";
      const top = `<tr><td style="padding:16px 18px;"><table cellpadding="0" cellspacing="0" border="0"><tr>${side}<td style="vertical-align:top;"><div style="font-size:17px;font-weight:bold;color:#111111;">${p.name}</div>${role}${companyLine(p)}${contacts(p)}</td></tr></table></td></tr>`;
      const foot =
        p.social || p.cta || p.logo
          ? `<tr><td bgcolor="${footBg}" style="background:${footBg};padding:4px 18px 12px;border-top:1px solid #e5e7eb;border-radius:0 0 8px 8px;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="vertical-align:middle;">${p.social}${p.cta}</td>${
              p.logo ? `<td align="right" style="padding:8px 0 0 16px;vertical-align:middle;">${signatureLogo(p, 90)}</td>` : ""
            }</tr></table></td></tr>`
          : "";
      return `${signatureTable(p, "border:1px solid #e5e7eb;border-collapse:separate;border-radius:8px;")}${top}${foot}</table>`;
    }
    case "spotlight": {
      // The name in the colour only where the colour reads on white.
      const nameColor = p.ink === "#ffffff" ? p.color : "#111111";
      const photo = p.photo ? `<td style="padding:0 16px 0 0;vertical-align:top;">${signatureImg(p.photo, p.name, 96, 96, 12)}</td>` : "";
      const bar = `<td width="4" bgcolor="${p.color}" style="background:${p.color};width:4px;font-size:0;line-height:0;">&nbsp;</td>`;
      const role = p.role ? `<div style="color:#555555;">${p.role}</div>` : "";
      const company = p.company ? `<div style="color:#111111;font-weight:bold;">${p.company}</div>` : "";
      const logo = p.logo ? `<div style="padding-top:10px;">${signatureLogo(p, 100)}</div>` : "";
      return `${open}<tr>${photo}${bar}<td style="padding:0 0 0 16px;vertical-align:top;"><div style="font-size:20px;font-weight:bold;color:${nameColor};">${p.name}</div>${role}${company}${contacts(p)}${p.social}${p.cta}${logo}</td></tr></table>`;
    }
  }
}

/** A signature in any layout the paid product offers. The paid product carries no credit, so `madeWith` is usually null. */
export function renderAnySignature(d: SignatureDetails, style: SignatureStyle<SignatureLayout>, madeWith: { href: string; name: string } | null): string {
  if (!isPremiumLayout(style.template)) return renderSignature(d, { ...style, template: style.template }, madeWith);
  const p = signatureParts(d, style, madeWith);
  return finishSignature(p, premiumBody(style.template, p, d));
}
