/**
 * Email signatures (docs/digital-cards-and-signatures.md §5): the details a signature carries, the
 * layout a template describes, and the email-safe HTML they make together.
 *
 * Client-safe on purpose — the public generator previews the free templates live in the browser. The
 * premium templates' layouts are NOT here: they live in src/lib/signatures/premium.ts, which only the
 * server reads, and the public page shows them as watermarked images, not HTML to copy. The renderer
 * itself does ship, so the line is practical, not cryptographic: somebody determined could rebuild a
 * premium-like layout from this code. What a paid workspace gets that they can't is the in-app page —
 * signatures filled from each person's record, the company's lock, the hosted photo, card and QR.
 *
 * The HTML is written for mail clients, not browsers: tables, inline styles, no classes, no scripts,
 * nothing a client strips. Every value is escaped, and a link is a link only when it is http(s), a
 * checked mailto: or tel: — a value typed as "javascript:" is text.
 */

export type SocialKey = "linkedin" | "x" | "instagram" | "facebook" | "youtube";

export const SOCIALS: readonly { key: SocialKey; label: string; badge: string }[] = [
  { key: "linkedin", label: "LinkedIn", badge: "in" },
  { key: "x", label: "X", badge: "X" },
  { key: "instagram", label: "Instagram", badge: "IG" },
  { key: "facebook", label: "Facebook", badge: "f" },
  { key: "youtube", label: "YouTube", badge: "YT" },
];

/** What a signature says. Every field optional but the name; image fields are absolute http(s) URLs. */
export type SignatureData = {
  name: string;
  title?: string;
  department?: string;
  company?: string;
  phone?: string;
  mobile?: string;
  email?: string;
  website?: string;
  address?: string;
  logoUrl?: string;
  photoUrl?: string;
  accent?: string;
  socials?: Partial<Record<SocialKey, string>>;
  /** The person's digital card (Deskzo Cards), and its QR code as an image. */
  cardUrl?: string;
  qrUrl?: string;
  banner?: { imageUrl: string; link?: string };
  disclaimer?: string;
};

/**
 * A template, as a description rather than code: the generator and the in-app page render the same
 * description, and the preview image (src/lib/signatures/preview.tsx) draws it too.
 */
export type SignatureLayout = {
  key: string;
  name: string;
  tier: "free" | "premium";
  blurb: string;
  arrangement: "stacked" | "side" | "inline" | "centered" | "split";
  /** What the side column holds in a side or split arrangement. */
  side?: "photo" | "logo";
  photo: "none" | "round" | "square";
  divider: "none" | "vertical" | "top" | "left-bar";
  nameStyle: "bold" | "accent" | "caps";
  logo: "none" | "below" | "side";
  contacts: "labelled" | "plain" | "inline";
  socials: "none" | "text" | "badges";
  card?: "button" | "button-qr";
  banner?: boolean;
  disclaimer?: boolean;
};

export const DEFAULT_ACCENT = "#2563eb";
export const MAX_SIGNATURE_FIELD = 200;

/** The four anybody may use, on the public page and in every workspace. */
export const FREE_LAYOUTS: readonly SignatureLayout[] = [
  {
    key: "simple",
    name: "Simple",
    tier: "free",
    blurb: "Name, title and the ways to reach you. Nothing else.",
    arrangement: "stacked",
    photo: "none",
    divider: "none",
    nameStyle: "bold",
    logo: "none",
    contacts: "plain",
    socials: "text",
  },
  {
    key: "divider",
    name: "Divider",
    tier: "free",
    blurb: "Your logo beside your details, split by a line in your colour.",
    arrangement: "side",
    side: "logo",
    photo: "none",
    divider: "vertical",
    nameStyle: "accent",
    logo: "side",
    contacts: "labelled",
    socials: "text",
  },
  {
    key: "compact",
    name: "Compact",
    tier: "free",
    blurb: "Two lines, for replies and phones.",
    arrangement: "inline",
    photo: "none",
    divider: "none",
    nameStyle: "bold",
    logo: "none",
    contacts: "inline",
    socials: "none",
  },
  {
    key: "classic",
    name: "Classic",
    tier: "free",
    blurb: "Details first, your logo underneath.",
    arrangement: "stacked",
    photo: "none",
    divider: "top",
    nameStyle: "caps",
    logo: "below",
    contacts: "labelled",
    socials: "text",
  },
];

/** What the public page may say about a premium template — its name and what it's for, never its layout. */
export type PremiumTeaser = { key: string; name: string; blurb: string };

export const PREMIUM_TEASERS: readonly PremiumTeaser[] = [
  { key: "portrait", name: "Portrait", blurb: "Your photo beside your details, social badges in your colour." },
  { key: "executive", name: "Executive", blurb: "A square photo, your name in capitals, a bar in your colour." },
  { key: "card", name: "Card link", blurb: "A button to your digital card and its QR code." },
  { key: "campaign", name: "Campaign", blurb: "A banner under your signature for this month's offer." },
  { key: "centered", name: "Centred", blurb: "Everything centred under a round photo." },
  { key: "accent-bar", name: "Accent bar", blurb: "A bold bar in your colour down the left." },
  { key: "split", name: "Split", blurb: "Your logo on a block of your colour, details beside it." },
  { key: "legal", name: "Legal", blurb: "Photo, banner and your company's disclaimer underneath." },
];

export function isFreeLayout(key: string): boolean {
  return FREE_LAYOUTS.some((l) => l.key === key);
}

// ─── Values ────────────────────────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-fA-F]{6}$/;

export function escapeHtml(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** An http(s) URL, made absolute — "acme.in" becomes https://acme.in/ — or null for anything else. */
export function safeUrl(value: string | undefined | null): string | null {
  const v = value?.trim();
  if (!v || v.length > 2000) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : /^[a-z][a-z0-9+.-]*:/i.test(v) ? null : `https://${v}`;
  if (!withScheme) return null;
  try {
    const u = new URL(withScheme);
    return (u.protocol === "https:" || u.protocol === "http:") && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

function telHref(v: string): string | null {
  const digits = v.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 6 ? `tel:${digits}` : null;
}

function mailHref(v: string): string | null {
  return /^[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+$/.test(v) ? `mailto:${v}` : null;
}

function accentOf(d: SignatureData): string {
  return d.accent && HEX.test(d.accent) ? d.accent : DEFAULT_ACCENT;
}

/** Trimmed, length-capped, empty dropped — what every renderer reads. */
export function cleanData(raw: SignatureData): SignatureData {
  const t = (v: unknown, max = MAX_SIGNATURE_FIELD) => (typeof v === "string" ? v.trim().slice(0, max) : "") || undefined;
  const socials: Partial<Record<SocialKey, string>> = {};
  for (const s of SOCIALS) {
    const v = t(raw.socials?.[s.key]);
    if (v) socials[s.key] = v;
  }
  const bannerUrl = t(raw.banner?.imageUrl, 2000);
  return {
    name: t(raw.name, 100) ?? "",
    title: t(raw.title),
    department: t(raw.department),
    company: t(raw.company),
    phone: t(raw.phone, 40),
    mobile: t(raw.mobile, 40),
    email: t(raw.email),
    website: t(raw.website),
    address: t(raw.address, 300),
    logoUrl: t(raw.logoUrl, 2000),
    photoUrl: t(raw.photoUrl, 2000),
    accent: raw.accent && HEX.test(raw.accent) ? raw.accent : undefined,
    socials,
    cardUrl: t(raw.cardUrl, 2000),
    qrUrl: t(raw.qrUrl, 2000),
    banner: bannerUrl ? { imageUrl: bannerUrl, link: t(raw.banner?.link, 2000) } : undefined,
    disclaimer: t(raw.disclaimer, 600),
  };
}

// ─── HTML ──────────────────────────────────────────────────────────────────────────────────────

const FONT = "font-family:Arial,Helvetica,sans-serif;";
const TEXT = "#333333";
const MUTED = "#6b7280";

function link(href: string | null, text: string, style: string): string {
  const t = escapeHtml(text);
  return href ? `<a href="${escapeHtml(href)}" style="${style}text-decoration:none;" target="_blank" rel="noopener">${t}</a>` : `<span style="${style}">${t}</span>`;
}

function img(src: string | null, alt: string, width: number, extra = ""): string {
  if (!src) return "";
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" width="${width}" style="display:block;border:0;max-width:${width}px;${extra}">`;
}

type Parts = {
  accent: string;
  name: string;
  role: string;
  contacts: string;
  socials: string;
  logo: (width: number) => string;
  photo: (size: number) => string;
  card: string;
  banner: string;
  disclaimer: string;
};

function parts(layout: SignatureLayout, d: SignatureData): Parts {
  const accent = accentOf(d);
  const nameCss =
    layout.nameStyle === "accent"
      ? `color:${accent};font-weight:bold;font-size:16px;`
      : layout.nameStyle === "caps"
        ? `color:${TEXT};font-weight:bold;font-size:15px;letter-spacing:1px;text-transform:uppercase;`
        : `color:${TEXT};font-weight:bold;font-size:16px;`;
  const name = `<span style="${FONT}${nameCss}">${escapeHtml(d.name)}</span>`;
  const roleText = [d.title, d.department, d.company].filter(Boolean).join(" · ");
  const role = roleText ? `<span style="${FONT}color:${MUTED};font-size:13px;">${escapeHtml(roleText)}</span>` : "";

  const items: { label: string; html: string }[] = [];
  const cstyle = `${FONT}color:${TEXT};font-size:13px;`;
  if (d.phone) items.push({ label: "P", html: link(telHref(d.phone), d.phone, cstyle) });
  if (d.mobile) items.push({ label: "M", html: link(telHref(d.mobile), d.mobile, cstyle) });
  if (d.email) items.push({ label: "E", html: link(mailHref(d.email), d.email, cstyle) });
  if (d.website) {
    const href = safeUrl(d.website);
    items.push({ label: "W", html: link(href, d.website.replace(/^https?:\/\//i, "").replace(/\/$/, ""), cstyle) });
  }
  if (d.address) items.push({ label: "A", html: `<span style="${cstyle}">${escapeHtml(d.address)}</span>` });
  const contacts =
    layout.contacts === "inline"
      ? items.map((i) => i.html).join(`<span style="color:${MUTED};"> &nbsp;|&nbsp; </span>`)
      : items
          .map((i) =>
            layout.contacts === "labelled"
              ? `<span style="${FONT}color:${accent};font-weight:bold;font-size:12px;">${i.label}&nbsp;</span>${i.html}`
              : i.html,
          )
          .join("<br>");

  const socialLinks = SOCIALS.flatMap((s) => {
    const href = safeUrl(d.socials?.[s.key]);
    return href ? [{ ...s, href }] : [];
  });
  const socials =
    layout.socials === "none" || socialLinks.length === 0
      ? ""
      : layout.socials === "badges"
        ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr>${socialLinks
            .map(
              (s) =>
                `<td style="padding:0 4px 0 0;"><a href="${escapeHtml(s.href)}" target="_blank" rel="noopener" style="${FONT}display:inline-block;background:${accent};color:#ffffff;font-size:11px;font-weight:bold;line-height:22px;width:22px;text-align:center;border-radius:4px;text-decoration:none;">${escapeHtml(s.badge)}</a></td>`,
            )
            .join("")}</tr></table>`
        : socialLinks.map((s) => link(s.href, s.label, `${FONT}color:${accent};font-size:12px;`)).join(`<span style="color:${MUTED};"> · </span>`);

  const logoSrc = safeUrl(d.logoUrl);
  const photoSrc = safeUrl(d.photoUrl);
  const cardHref = safeUrl(d.cardUrl);
  const qrSrc = safeUrl(d.qrUrl);
  const card =
    layout.card && cardHref
      ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td style="padding:0 10px 0 0;vertical-align:middle;"><a href="${escapeHtml(cardHref)}" target="_blank" rel="noopener" style="${FONT}display:inline-block;background:${accent};color:#ffffff;font-size:12px;font-weight:bold;padding:6px 12px;border-radius:4px;text-decoration:none;">View my digital card</a></td>${
          layout.card === "button-qr" && qrSrc ? `<td style="vertical-align:middle;">${img(qrSrc, "QR code for my digital card", 64)}</td>` : ""
        }</tr></table>`
      : "";
  const bannerSrc = layout.banner ? safeUrl(d.banner?.imageUrl) : null;
  const bannerHref = safeUrl(d.banner?.link);
  const bannerImg = img(bannerSrc, "", 480, "width:100%;height:auto;");
  const banner = bannerImg ? (bannerHref ? `<a href="${escapeHtml(bannerHref)}" target="_blank" rel="noopener">${bannerImg}</a>` : bannerImg) : "";
  const disclaimer =
    layout.disclaimer && d.disclaimer ? `<span style="${FONT}color:#9ca3af;font-size:10px;line-height:14px;">${escapeHtml(d.disclaimer)}</span>` : "";

  return {
    accent,
    name,
    role,
    contacts,
    socials,
    logo: (w) => img(logoSrc, d.company ?? "Logo", w, "height:auto;"),
    photo: (size) =>
      layout.photo === "none" ? "" : img(photoSrc, d.name, size, `width:${size}px;height:${size}px;object-fit:cover;${layout.photo === "round" ? `border-radius:${size / 2}px;` : "border-radius:4px;"}`),
    card,
    banner,
    disclaimer,
  };
}

/** Initials on a disc of the accent colour — a table cell, which every mail client draws. */
function initialsBadge(name: string, accent: string, size: number): string {
  const letters = name
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation"><tr><td width="${size}" height="${size}" align="center" valign="middle" style="${FONT}width:${size}px;height:${size}px;background:${accent};color:#ffffff;font-size:${Math.round(size / 2.6)}px;font-weight:bold;border-radius:${size / 2}px;text-align:center;">${escapeHtml(letters || "?")}</td></tr></table>`;
}

/** The company's name, set as a mark, where a template wants a logo nobody uploaded. */
function companyMark(company: string | undefined, color: string): string {
  return company ? `<span style="${FONT}color:${color};font-size:15px;font-weight:bold;">${escapeHtml(company)}</span>` : "";
}

const row = (html: string, pad = "2px 0") => (html ? `<tr><td style="padding:${pad};">${html}</td></tr>` : "");

/** The signature as email-safe HTML. `madeWith`: the free generator's small "Made with Deskzo" line. */
export function renderSignatureHtml(layout: SignatureLayout, raw: SignatureData, options: { madeWith?: { href: string; label: string } } = {}): string {
  const d = cleanData(raw);
  const p = parts(layout, d);
  const details = [row(p.name, "0 0 2px 0"), row(p.role, "0 0 6px 0"), row(p.contacts), row(p.socials, "6px 0 0 0"), row(p.card, "8px 0 0 0")].join("");
  let body: string;

  switch (layout.arrangement) {
    case "inline": {
      const first = [p.name, p.role].filter(Boolean).join(`<span style="color:${MUTED};"> &nbsp;|&nbsp; </span>`);
      body = `${row(first)}${row(p.contacts)}`;
      break;
    }
    case "side":
    case "split": {
      const split = layout.arrangement === "split";
      // With no logo or photo the side keeps its place: the company's name, or the person's initials.
      const sideHtml =
        (layout.side === "photo" ? p.photo(80) : p.logo(90)) ||
        (layout.side === "photo" ? initialsBadge(d.name, p.accent, 72) : companyMark(d.company, split ? "#ffffff" : p.accent));
      const sideCell = sideHtml
        ? `<td style="vertical-align:middle;padding:${split ? "12px" : "0 14px 0 0"};${split ? `background:${p.accent};` : ""}${layout.divider === "vertical" ? `border-right:2px solid ${p.accent};` : ""}">${sideHtml}</td>`
        : "";
      body = `<tr>${sideCell}<td style="vertical-align:middle;padding:0 0 0 ${sideHtml ? "14px" : "0"};"><table cellpadding="0" cellspacing="0" border="0" role="presentation">${details}</table></td></tr>`;
      break;
    }
    case "centered": {
      const photo = p.photo(72);
      const centred = details
        .replace(/<td style="/g, '<td align="center" style="text-align:center;')
        .replace(/<table cellpadding="0" cellspacing="0" border="0" role="presentation">/g, '<table cellpadding="0" cellspacing="0" border="0" role="presentation" align="center">');
      body = `<tr><td align="center" style="padding:0 0 8px 0;">${photo || initialsBadge(d.name, p.accent, 64)}</td></tr>${centred}`;
      break;
    }
    default: {
      const photo = p.photo(64);
      body = `${photo ? row(photo, "0 0 8px 0") : ""}${details}`;
      if (layout.logo === "below") body += row(p.logo(120), "10px 0 0 0");
    }
  }

  const accentBar = layout.divider === "top" ? `border-top:3px solid ${p.accent};padding-top:8px;` : layout.divider === "left-bar" ? `border-left:4px solid ${p.accent};padding-left:12px;` : "";
  const extra = [row(p.banner, "12px 0 0 0"), row(p.disclaimer, "10px 0 0 0")].join("");
  const made = options.madeWith
    ? row(`<a href="${escapeHtml(options.madeWith.href)}" target="_blank" rel="noopener" style="${FONT}color:#9ca3af;font-size:10px;text-decoration:none;">${escapeHtml(options.madeWith.label)}</a>`, "10px 0 0 0")
    : "";
  const inner = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="${FONT}color:${TEXT};${accentBar}">${body}</table>`;
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="${FONT}border-collapse:collapse;"><tr><td>${inner}</td></tr>${extra}${made}</table>`;
}

/** Plain text, for the mail clients that want one and the people who prefer it. */
export function renderSignatureText(raw: SignatureData): string {
  const d = cleanData(raw);
  return [
    d.name,
    [d.title, d.department, d.company].filter(Boolean).join(" · "),
    d.phone ? `P: ${d.phone}` : "",
    d.mobile ? `M: ${d.mobile}` : "",
    d.email ? `E: ${d.email}` : "",
    d.website ? `W: ${d.website}` : "",
    d.address ?? "",
    d.cardUrl ? `My card: ${d.cardUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Example details, for a template shown before anybody has typed anything. */
export const SAMPLE_SIGNATURE: SignatureData = {
  name: "Priya Sharma",
  title: "Head of Sales",
  company: "Acme Industries",
  phone: "+91 22 4000 1234",
  mobile: "+91 98765 43210",
  email: "priya@acme.example",
  website: "www.acme.example",
  address: "1 MG Road, Pune 411001",
  accent: DEFAULT_ACCENT,
  socials: { linkedin: "linkedin.com/in/priya", x: "x.com/priya" },
  disclaimer: "This email and any attachments are confidential and intended only for the addressee.",
};
