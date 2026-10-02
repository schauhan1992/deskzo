/**
 * What a help link, a video, or a "read more" on a What's new post may point at.
 *
 * These are typed in by an administrator and then clicked by everybody, so the rule is narrow on
 * purpose: an `https:` address, or a path inside the app. Not `http:` — a page anybody on the network
 * can rewrite, opened from inside the ERP, is a phishing page with our name on it — and never
 * `javascript:` or `data:`, which would run as the person who clicked.
 */
export type CheckedLink = { ok: true; url: string; external: boolean } | { ok: false; error: string };

export const LINK_MAX = 2000;

export function checkLink(raw: string): CheckedLink {
  const url = raw.trim();
  if (!url) return { ok: false, error: "Add a link." };
  if (url.length > LINK_MAX) return { ok: false, error: "That link is too long." };

  // An in-app path. "//host" is a protocol-relative address to somewhere else entirely, and "/\host"
  // is read the same way by browsers, so a single leading slash is the only form accepted. Nothing
  // inside it may undo that: a browser drops a tab or a line break from an address before reading it
  // ("/<tab>/evil.example" opens evil.example) and reads a backslash as "/".
  if (url.startsWith("/")) {
    if (url.startsWith("//") || url.startsWith("/\\")) return { ok: false, error: "Use a full https:// address for another site." };
    if (/[\s\p{Cc}]/u.test(url)) return { ok: false, error: "A link can't have spaces or line breaks in it." };
    if (url.includes("\\")) return { ok: false, error: "Use / between the parts of a path, not \\." };
    return { ok: true, url, external: false };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That isn't a link — start it with https:// or with / for a page in the app." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "Only https:// links are allowed." };
  if (parsed.username || parsed.password) return { ok: false, error: "Links can't carry a username or password." };
  return { ok: true, url: parsed.toString(), external: true };
}

/**
 * The YouTube video id in a watch, short or embed link, or null. Used only to show a thumbnail
 * beside a video in the rail — the video itself always opens on YouTube, never embedded here.
 */
export function youtubeId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\.|^m\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = parsed.pathname.slice(1).split("/")[0] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parsed.pathname === "/watch") id = parsed.searchParams.get("v");
    else {
      const m = parsed.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
}
