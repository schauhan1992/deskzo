import sanitizeHtml from "sanitize-html";
import type { TemplateFormat } from "@prisma/client";

/**
 * Turning a template into the email that actually leaves — and making sure an uploaded one cannot
 * carry anything that runs.
 *
 * ## Two formats
 *
 * TEXT is what the editor has always written: plain words and line breaks. It becomes HTML here —
 * escaped, paragraphs kept, bare links made clickable — rather than being handed to the provider as
 * if it already were HTML, which is how every line break used to vanish.
 *
 * HTML is uploaded or pasted: an export from Stripo, BEE, Mailchimp, Canva. It is cleaned once, on
 * save, by `sanitizeEmailHtml`, and trusted from then on; the values merged into it at send time are
 * escaped, so a company called "A & B <x>" arrives as that and not as markup.
 *
 * ## What every marketing email gets, whichever format
 *
 *   · the preheader — the grey line after the subject in an inbox — hidden in the body;
 *   · a footer with an unsubscribe link and the postal address, unless the author placed their own;
 *   · the open pixel and tracked links, when the campaign tracks them;
 *   · absolute addresses for the pictures we host, because a mail client has no idea where "/" is;
 *   · a plain-text part of its own, because HTML-only mail reads as spam.
 */

// ─── Cleaning uploaded HTML ─────────────────────────────────────────────────

const EMAIL_TAGS = [
  "html", "head", "body", "title", "meta", "style",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "col", "colgroup",
  "div", "span", "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "img", "b", "strong", "i", "em", "u", "s", "strike", "small", "big", "sup", "sub",
  "ul", "ol", "li", "dl", "dt", "dd", "blockquote", "pre", "code", "font", "center",
  "section", "header", "footer", "article", "main", "aside", "figure", "figcaption",
  "address", "abbr", "cite", "q", "mark", "wbr",
];

const LAYOUT_ATTRIBUTES = [
  "style", "class", "id", "align", "valign", "width", "height", "bgcolor", "background", "border",
  "bordercolor", "dir", "lang", "title", "role", "aria-label", "aria-hidden", "colspan", "rowspan",
  "cellpadding", "cellspacing", "nowrap", "color", "face", "size", "hspace", "vspace",
];

/** CSS that has ever executed something, in some client, somewhere. Neutralised wherever it appears. */
const DANGEROUS_CSS = /(expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding|behavior\s*:|@import)/gi;

/**
 * Keeps what an email layout needs — tables, inline styles, a `<style>` block, images from the web —
 * and discards everything that can run or submit: scripts, event handlers, forms, frames, embedded
 * objects, SVG, `<base>`, `<link>`, meta refreshes, and `javascript:` in any link or style.
 */
export function sanitizeEmailHtml(html: string): string {
  const clean = sanitizeHtml(html, {
    allowedTags: EMAIL_TAGS,
    allowedAttributes: {
      "*": LAYOUT_ATTRIBUTES,
      a: ["href", "target", "rel", "name"],
      img: ["src", "alt"],
      // A charset or a viewport, nothing else — `http-equiv` is how a meta tag redirects.
      meta: ["charset", "name", "content"],
    },
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "background"],
    allowProtocolRelative: false,
    // `<style>` is on the list, and sanitize-html asks for this before it will keep one. Its content
    // is scrubbed below like every other piece of CSS.
    allowVulnerableTags: true,
    nonTextTags: ["script", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math"],
    exclusiveFilter: (frame) => frame.tag === "meta" && !frame.attribs.charset && !/^(viewport|x-apple-disable-message-reformatting|format-detection|color-scheme|supported-color-schemes)$/i.test(frame.attribs.name ?? ""),
  });
  return clean.replace(DANGEROUS_CSS, "blocked-");
}

/** What cleaning took out, counted before and after — so the author is told, not surprised. */
const RISKY = [
  { label: "scripts", pattern: /<script\b/gi },
  { label: "forms and inputs", pattern: /<(form|input|button|select|textarea)\b/gi },
  { label: "embedded frames or objects", pattern: /<(iframe|object|embed|frame)\b/gi },
  { label: "event handlers (onclick and the like)", pattern: /\son[a-z]+\s*=/gi },
  { label: "javascript: links", pattern: /javascript\s*:/gi },
  { label: "external stylesheets", pattern: /<link\b/gi },
];

export function removedInCleaning(before: string, after: string): string[] {
  return RISKY.flatMap(({ label, pattern }) => {
    const was = before.match(pattern)?.length ?? 0;
    const now = after.match(pattern)?.length ?? 0;
    return was > now ? [`${was - now} ${label}`] : [];
  });
}

// ─── Escaping and plain text ────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

export function decodeEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_m, e: string) => ENTITIES[e] ?? _m).replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)));
}

/** Plain text into HTML: escaped, blank lines into paragraphs, single breaks kept, bare links made links. */
export function textToHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => {
      const linked = escapeHtml(para).replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => `<a href="${url}">${url}</a>`);
      return `<p style="margin:0 0 14px">${linked.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

/** HTML into readable plain text — a link keeps its address in brackets, so it still works. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)[\s\S]*?<\/\1>/gi, "")
      .replace(/<a\b[^>]*?\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
        const label = inner.replace(/<[^>]+>/g, "").trim();
        const url = decodeEntities(href);
        return !label || label === url || url.startsWith("mailto:") ? label || url : `${label} (${url})`;
      })
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote|section|header|footer)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── The email that leaves ──────────────────────────────────────────────────

/** Where the pictures we host live — root-relative in a stored template, absolute in a sent email. */
export const ASSET_PATH = "/api/marketing/assets/";

export type ComposeInput = {
  format: TemplateFormat;
  /** The body with its merge fields already filled in — escaped, for HTML. */
  body: string;
  preheader?: string | null;
  footer: {
    senderName: string;
    unsubscribeUrl: string | null;
    postalAddress: string | null;
    /** False when the author placed their own unsubscribe link — one is enough. */
    includeUnsubscribe: boolean;
    includeAddress: boolean;
  };
  /** Absolute origin for our own pictures. */
  origin: string;
  track?: {
    openPixelUrl: string | null;
    /** The tracked address for a link, or null to leave it alone. */
    link: ((url: string) => string | null) | null;
  };
};

function footerHtml(f: ComposeInput["footer"]): string {
  const lines: string[] = [];
  if (f.includeUnsubscribe && f.unsubscribeUrl) {
    lines.push(`You're receiving this from ${escapeHtml(f.senderName)}. <a href="${escapeHtml(f.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe or choose what you hear about</a>.`);
  }
  if (f.includeAddress && f.postalAddress) lines.push(escapeHtml(f.postalAddress).replace(/\n/g, "<br>"));
  if (lines.length === 0) return "";
  return `<div style="margin:28px auto 0;padding:14px 16px 0;max-width:640px;border-top:1px solid #e5e7eb;font:12px/1.6 Arial,Helvetica,sans-serif;color:#6b7280;text-align:center">${lines.join("<br>")}</div>`;
}

function footerText(f: ComposeInput["footer"]): string {
  const lines: string[] = [];
  if (f.includeUnsubscribe && f.unsubscribeUrl) lines.push(`Unsubscribe or choose what you hear about: ${f.unsubscribeUrl}`);
  if (f.includeAddress && f.postalAddress) lines.push(f.postalAddress);
  return lines.length ? `\n\n--\n${lines.join("\n")}` : "";
}

/** Every `<a href>` pointing at the web, through the tracker. mailto:, tel: and anchors are left alone. */
export function rewriteLinks(html: string, link: (url: string) => string | null): string {
  return html.replace(/(<a\b[^>]*?\bhref\s*=\s*")([^"]*)(")/gi, (whole, before: string, href: string, after: string) => {
    const url = decodeEntities(href);
    if (!/^https?:\/\//i.test(url)) return whole;
    const tracked = link(url);
    return tracked ? `${before}${escapeHtml(tracked)}${after}` : whole;
  });
}

export function absolutiseAssets(html: string, origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return html.replace(/(["'(\s])\/api\/marketing\/assets\//g, `$1${base}${ASSET_PATH}`);
}

export function composeEmail(input: ComposeInput): { html: string; text: string } {
  const content = input.format === "TEXT" ? textToHtml(input.body) : input.body;
  const preheader = input.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(input.preheader.trim())}</div>`
    : "";
  const footer = footerHtml(input.footer);
  const pixel = input.track?.openPixelUrl
    ? `<img src="${escapeHtml(input.track.openPixelUrl)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0">`
    : "";

  let html: string;
  if (/<body[\s>]/i.test(content)) {
    // A whole document of its own: the preheader goes first thing in its body, the footer and the
    // pixel last, and nothing about its own layout is touched.
    html = content.replace(/<body([^>]*)>/i, `<body$1>${preheader}`);
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${footer}${pixel}</body>`) : `${html}${footer}${pixel}`;
    if (!/^\s*<!doctype/i.test(html)) html = `<!doctype html>\n${html}`;
  } else {
    html =
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
      `<body style="margin:0;padding:0;background:#ffffff">${preheader}` +
      `<div style="max-width:640px;margin:0 auto;padding:24px 16px;font:15px/1.6 Arial,Helvetica,sans-serif;color:#1f2937">${content}</div>` +
      `${footer}${pixel}</body></html>`;
  }

  // Links first, then pictures: a tracked link must never wrap the unsubscribe address, and the
  // tracker is told the real destination rather than a root-relative one.
  const unsubscribe = input.footer.unsubscribeUrl;
  if (input.track?.link) {
    const track = input.track.link;
    html = rewriteLinks(html, (url) => (unsubscribe && url === unsubscribe ? null : track(url)));
  }
  html = absolutiseAssets(html, input.origin);

  const text = (input.format === "TEXT" ? input.body.replace(/\r\n?/g, "\n").trim() : htmlToText(content)) + footerText(input.footer);
  return { html, text };
}
