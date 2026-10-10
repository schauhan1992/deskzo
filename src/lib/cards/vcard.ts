import { handleFrom, type DrawnCard, type FieldKind } from "@/lib/cards/fields";

/**
 * A card as a contact file — Save contact on the card page. Server-only: it folds lines by UTF-8 bytes.
 */

/** RFC 6350 text: backslash, comma, semicolon and newlines escaped. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\r?\n/g, "\\n");
}

/** Lines longer than 75 octets folded, as the format asks — some phones refuse a card that isn't. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let first = true;
  while (start < bytes.length) {
    let end = Math.min(start + (first ? 75 : 74), bytes.length);
    // Never split a multi-byte character.
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
    parts.push((first ? "" : " ") + bytes.subarray(start, end).toString("utf8"));
    start = end;
    first = false;
  }
  return parts.join("\r\n");
}

const SOCIAL_TYPES: Partial<Record<FieldKind, string>> = { linkedin: "linkedin", x: "twitter", instagram: "instagram", facebook: "facebook", youtube: "youtube" };

/**
 * The card as a vCard 3.0 — the version every phone's contacts app reads. The photo goes in when the
 * card shows one, as base64 (the 96KB cap on photos keeps the file small).
 */
export function buildVCard(card: DrawnCard, opts: { cardUrl: string; photo?: { mimeType: string; base64: string } | null }): string {
  const parts = card.name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1]! : "";
  const given = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(family)};${esc(given)};;;`, `FN:${esc(card.name)}`];
  if (card.company) lines.push(`ORG:${esc(card.company)}${card.department ? `;${esc(card.department)}` : ""}`);
  if (card.title) lines.push(`TITLE:${esc(card.title)}`);
  for (const f of card.fields) {
    if (f.kind === "phone") lines.push(`TEL;TYPE=WORK,VOICE:${esc(f.value)}`);
    else if (f.kind === "whatsapp") lines.push(`TEL;TYPE=CELL:${esc(f.value)}`);
    else if (f.kind === "email") lines.push(`EMAIL;TYPE=INTERNET,WORK:${esc(f.value)}`);
    else if (f.kind === "address") lines.push(`ADR;TYPE=WORK:;;${esc(f.value)};;;;`);
    else if (SOCIAL_TYPES[f.kind]) lines.push(`X-SOCIALPROFILE;TYPE=${SOCIAL_TYPES[f.kind]}:${esc(f.value)}`, `URL:${esc(f.value)}`);
    else if (f.kind === "website" || f.kind === "calendar" || f.kind === "link") lines.push(`URL:${esc(f.value)}`);
  }
  lines.push(`URL;TYPE=Card:${esc(opts.cardUrl)}`);
  if (opts.photo) {
    const type = opts.photo.mimeType.split("/")[1]?.toUpperCase() ?? "JPEG";
    lines.push(`PHOTO;ENCODING=b;TYPE=${type === "JPG" ? "JPEG" : type}:${opts.photo.base64}`);
  }
  lines.push("END:VCARD");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

/** The file name a saved card downloads as. */
export function vcardFileName(name: string): string {
  return `${handleFrom(name) || "contact"}.vcf`;
}
