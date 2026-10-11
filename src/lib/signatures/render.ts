/**
 * An email signature as HTML a mail program keeps: tables and inline styles only — no stylesheet, no
 * script, no web fonts, no SVG — so Gmail, Outlook (the Word-based desktop one too) and Apple Mail
 * show it the same. Pure: the free generator on the website builds it in the browser, and the paid
 * Signatures product will build the same thing on the server.
 *
 * Everything a person typed is escaped, and a link is only ever http(s), mailto: or tel: — a signature
 * travels in every email somebody sends, so a stray `javascript:` would travel with it.
 */

export const SIGNATURE_TEMPLATES = [
  { key: "classic", label: "Classic", hint: "Photo or logo at the side" },
  { key: "modern", label: "Modern", hint: "A colour bar over the name" },
  { key: "stacked", label: "Stacked", hint: "Logo under the details" },
  { key: "compact", label: "Compact", hint: "Two lines, nothing more" },
] as const;
export type SignatureTemplate = (typeof SIGNATURE_TEMPLATES)[number]["key"];

/** Fonts every mail program has, so the signature looks the same at the other end. */
export const SIGNATURE_FONTS = {
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  tahoma: { label: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
  trebuchet: { label: "Trebuchet", stack: "'Trebuchet MS', Helvetica, sans-serif" },
  georgia: { label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
} as const;
export type SignatureFont = keyof typeof SIGNATURE_FONTS;

export const SOCIAL_NETWORKS = [
  { key: "linkedin", label: "LinkedIn", badge: "in" },
  { key: "x", label: "X", badge: "X" },
  { key: "facebook", label: "Facebook", badge: "f" },
  { key: "instagram", label: "Instagram", badge: "ig" },
  { key: "youtube", label: "YouTube", badge: "yt" },
] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number]["key"];

export type SignatureDetails = {
  name: string;
  jobTitle: string;
  department: string;
  company: string;
  phone: string;
  mobile: string;
  email: string;
  website: string;
  address: string;
  /** An image's address — or, from the file picker, a data: URL (see `imageNote`). */
  photo: string;
  logo: string;
  social: Record<SocialNetwork, string>;
  signOff: string;
  ctaLabel: string;
  ctaUrl: string;
  disclaimer: string;
};

export type SignatureStyle = { template: SignatureTemplate; color: string; font: SignatureFont };

export const EMPTY_DETAILS: SignatureDetails = {
  name: "",
  jobTitle: "",
  department: "",
  company: "",
  phone: "",
  mobile: "",
  email: "",
  website: "",
  address: "",
  photo: "",
  logo: "",
  social: { linkedin: "", x: "", facebook: "", instagram: "", youtube: "" },
  signOff: "",
  ctaLabel: "",
  ctaUrl: "",
  disclaimer: "",
};

/** Gmail refuses a signature longer than this many characters of HTML. */
export const GMAIL_LIMIT = 10_000;

// ── Safety ──────────────────────────────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HEX = /^#[0-9a-f]{6}$/i;

export function safeColor(value: string, fallback = "#1d4ed8"): string {
  return HEX.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

/** A web address as typed — "company.com" — made one a mail program opens. Null for anything else. */
export function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.length > 500) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const EMAIL = /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/;
const PHONE = /^\+?[0-9][0-9 ().-]{4,30}$/;

export function safeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return EMAIL.test(value) && value.length <= 200 ? value : null;
}

export function safePhone(raw: string): string | null {
  const value = raw.trim();
  return PHONE.test(value) ? value : null;
}

const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;

/** An image: an http(s) address, or a picked file's data: URL (png, jpeg, gif or webp only). */
export function safeImage(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("data:")) return DATA_IMAGE.test(value) && value.length <= 200_000 ? value : null;
  return safeUrl(value);
}

/** What to tell somebody about an image they chose, or null when it will travel fine. */
export function imageNote(raw: string): string | null {
  if (!raw.trim()) return null;
  if (raw.trim().startsWith("data:")) return "A picked file shows in Outlook and Apple Mail, but Gmail won't show it — for Gmail, use a link to the image on your website.";
  return safeImage(raw) ? null : "That isn't an image address. Use one starting https://.";
}

const clean = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

// ── Building ────────────────────────────────────────────────────────────────────────────────────────

/** Text that reads on the colour: near-black on a light one, white on a dark one. */
function inkOn(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return "#ffffff";
  const ch = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(m[1]!) + 0.7152 * ch(m[2]!) + 0.0722 * ch(m[3]!) > 0.179 ? "#111111" : "#ffffff";
}

type Parts = {
  font: string;
  color: string;
  ink: string;
  name: string;
  role: string;
  company: string;
  photo: string | null;
  logo: string | null;
  lines: string[];
  social: string;
  cta: string;
  signOff: string;
  disclaimer: string;
  madeWith: string;
};

function parts(d: SignatureDetails, style: SignatureStyle, madeWith: { href: string; name: string } | null): Parts {
  const color = safeColor(style.color);
  const ink = inkOn(color);
  const font = (SIGNATURE_FONTS[style.font] ?? SIGNATURE_FONTS.arial).stack;
  const link = (href: string, text: string) => `<a href="${escapeHtml(href)}" style="color:#555555;text-decoration:none;">${escapeHtml(text)}</a>`;
  const label = (letter: string) => `<span style="color:${color};font-weight:bold;">${letter}</span>&nbsp;`;

  const lines: string[] = [];
  const phone = safePhone(d.phone);
  const mobile = safePhone(d.mobile);
  const phones = [
    phone ? `${label("T")}${link(`tel:${phone.replace(/[^0-9+]/g, "")}`, phone)}` : null,
    mobile ? `${label("M")}${link(`tel:${mobile.replace(/[^0-9+]/g, "")}`, mobile)}` : null,
  ].filter(Boolean);
  if (phones.length) lines.push(phones.join("&nbsp;&nbsp;"));
  const email = safeEmail(d.email);
  if (email) lines.push(`${label("E")}${link(`mailto:${email}`, email)}`);
  const website = safeUrl(d.website);
  if (website) lines.push(`${label("W")}${link(website, website.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, ""))}`);
  const address = clean(d.address, 200);
  if (address) lines.push(`<span style="color:#555555;">${escapeHtml(address)}</span>`);

  const badges = SOCIAL_NETWORKS.flatMap((n) => {
    const href = safeUrl(d.social[n.key] ?? "");
    if (!href) return [];
    // A table cell with bgcolor: the one coloured box Outlook's Word engine draws.
    return [
      `<td style="padding:0 4px 0 0;"><table cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="${color}" width="22" height="22" align="center" style="background:${color};border-radius:4px;width:22px;height:22px;"><a href="${escapeHtml(href)}" title="${n.label}" style="display:block;color:${ink};font-family:Arial,Helvetica,sans-serif;font-size:10px;font-weight:bold;line-height:22px;text-decoration:none;">${n.badge}</a></td></tr></table></td>`,
    ];
  });
  const social = badges.length ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:8px;"><tr>${badges.join("")}</tr></table>` : "";

  const ctaUrl = safeUrl(d.ctaUrl);
  const ctaLabel = clean(d.ctaLabel, 60);
  const cta =
    ctaUrl && ctaLabel
      ? `<table cellpadding="0" cellspacing="0" border="0" style="margin-top:12px;"><tr><td bgcolor="${color}" style="background:${color};border-radius:4px;padding:7px 14px;"><a href="${escapeHtml(ctaUrl)}" style="color:${ink};font-family:${font};font-size:13px;font-weight:bold;text-decoration:none;">${escapeHtml(ctaLabel)}</a></td></tr></table>`
      : "";

  const disclaimer = clean(d.disclaimer, 600);
  return {
    font,
    color,
    ink,
    name: escapeHtml(clean(d.name, 80) || "Your name"),
    role: escapeHtml([clean(d.jobTitle, 80), clean(d.department, 80)].filter(Boolean).join(", ")),
    company: escapeHtml(clean(d.company, 100)),
    photo: safeImage(d.photo),
    logo: safeImage(d.logo),
    lines,
    social,
    cta,
    signOff: clean(d.signOff, 60) ? `<div style="padding-bottom:10px;color:#333333;">${escapeHtml(clean(d.signOff, 60))}</div>` : "",
    disclaimer: disclaimer ? `<div style="margin-top:12px;max-width:520px;font-size:10px;line-height:1.4;color:#999999;">${escapeHtml(disclaimer)}</div>` : "",
    madeWith: madeWith
      ? `<div style="margin-top:10px;font-size:10px;color:#aaaaaa;">Made with <a href="${escapeHtml(madeWith.href)}" style="color:#aaaaaa;text-decoration:underline;">${escapeHtml(madeWith.name)}</a></div>`
      : "",
  };
}

const img = (src: string, alt: string, width: number, height: number | null, round: boolean) =>
  `<img src="${escapeHtml(src)}" alt="${alt}" width="${width}"${height ? ` height="${height}"` : ""} style="display:block;border:0;${round ? "border-radius:50%;" : ""}width:${width}px;${height ? `height:${height}px;` : "height:auto;"}">`;

const details = (p: Parts, nameSize: number) =>
  [
    `<div style="font-size:${nameSize}px;font-weight:bold;color:#111111;">${p.name}</div>`,
    p.role ? `<div style="color:#555555;">${p.role}</div>` : "",
    p.company ? `<div style="color:${p.color};font-weight:bold;">${p.company}</div>` : "",
    p.lines.length ? `<div style="padding-top:6px;font-size:13px;line-height:1.6;">${p.lines.map((l) => `<div>${l}</div>`).join("")}</div>` : "",
    p.social,
  ].join("");

/**
 * The signature, as HTML. `madeWith` is the free generator's credit — null for the paid product,
 * which may take it off.
 */
export function renderSignature(d: SignatureDetails, style: SignatureStyle, madeWith: { href: string; name: string } | null): string {
  const p = parts(d, style, madeWith);
  const open = `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:${p.font};font-size:14px;line-height:1.4;color:#333333;">`;
  let body: string;

  switch (style.template) {
    case "modern": {
      body = `${open}<tr><td style="border-top:3px solid ${p.color};padding-top:10px;">${
        p.logo ? `<div style="padding-bottom:8px;">${img(p.logo, p.company || "Logo", 120, null, false)}</div>` : ""
      }${details(p, 18)}${p.cta}</td></tr></table>`;
      break;
    }
    case "stacked": {
      body = `${open}<tr><td>${details(p, 16)}${p.logo ? `<div style="padding-top:10px;">${img(p.logo, p.company || "Logo", 120, null, false)}</div>` : ""}${p.cta}</td></tr></table>`;
      break;
    }
    case "compact": {
      const head = [`<strong style="color:#111111;">${p.name}</strong>`, p.role, p.company ? `<span style="color:${p.color};font-weight:bold;">${p.company}</span>` : ""].filter(Boolean).join(" &nbsp;|&nbsp; ");
      body = `${open}<tr><td><div>${head}</div>${p.lines.length ? `<div style="font-size:13px;line-height:1.6;">${p.lines.join(" &nbsp;|&nbsp; ")}</div>` : ""}${p.social}${p.cta}</td></tr></table>`;
      break;
    }
    default: {
      const side = p.photo ? img(p.photo, p.name, 80, 80, true) : p.logo ? img(p.logo, p.company || "Logo", 90, null, false) : "";
      body = `${open}<tr>${
        side ? `<td style="padding:0 14px 0 0;vertical-align:top;">${side}</td>` : ""
      }<td style="${side ? `border-left:2px solid ${p.color};padding:0 0 0 14px;` : ""}vertical-align:top;">${details(p, 16)}${p.cta}</td></tr></table>`;
    }
  }
  return `<div style="font-family:${p.font};">${p.signOff}${body}${p.disclaimer}${p.madeWith}</div>`;
}

/** The same signature as plain text, for mail programs set to plain text. */
export function signatureText(d: SignatureDetails, madeWith: { href: string; name: string } | null): string {
  const lines = [
    clean(d.signOff, 60),
    clean(d.name, 80),
    [clean(d.jobTitle, 80), clean(d.department, 80)].filter(Boolean).join(", "),
    clean(d.company, 100),
    [safePhone(d.phone) ? `T ${safePhone(d.phone)}` : "", safePhone(d.mobile) ? `M ${safePhone(d.mobile)}` : ""].filter(Boolean).join("  "),
    safeEmail(d.email) ?? "",
    safeUrl(d.website) ?? "",
    clean(d.address, 200),
    ...SOCIAL_NETWORKS.flatMap((n) => {
      const href = safeUrl(d.social[n.key] ?? "");
      return href ? [`${n.label}: ${href}`] : [];
    }),
    clean(d.disclaimer, 600),
    madeWith ? `Made with ${madeWith.name}: ${madeWith.href}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
