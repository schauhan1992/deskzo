import { SLUG_PATTERN } from "@/lib/workspace-names";

/**
 * The website's chat bubble (owner, 24 Oct 2026: "i would need chat on deskzo.com main website also"):
 * the Customer inbox of one of the platform's own workspaces — Deskzo's — shown on every page of the
 * public site, so a visitor's message lands in that workspace's Inbox like any other website chat.
 *
 * The CMS keeps only the workspace's name and the chat's key (Settings › General › Website chat), never a
 * script address: the site makes the address itself, from the workspace's name on the platform's own domain
 * (src/components/site/site-chat.tsx), so no setting can make deskzo.com load a script from anywhere else.
 * Pure and client-safe: the CMS's form, its validator and the site share it.
 */

export type SiteChat = { workspace: string; key: string };

/** A Customer inbox website channel's key, as src/actions/inbox-admin.ts makes them (12 random bytes, base64url). */
export const CHAT_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** On when both are set and both are well formed. */
export function chatIsOn(chat: Partial<SiteChat> | null | undefined): chat is SiteChat {
  return !!chat && SLUG_PATTERN.test(chat.workspace ?? "") && CHAT_KEY_PATTERN.test(chat.key ?? "");
}

/** What is wrong with the setting, field by field — nothing when both are empty (no chat) or both are right. */
export function chatProblems(chat: Partial<SiteChat> | null | undefined): { workspace?: string; key?: string } {
  const workspace = (chat?.workspace ?? "").trim();
  const key = (chat?.key ?? "").trim();
  if (!workspace && !key) return {};
  return {
    ...(!workspace ? { workspace: "Which workspace's inbox answers the chat? Its name, as in name.deskzo.com." } : !SLUG_PATTERN.test(workspace) ? { workspace: "A workspace's name: lower-case letters, digits and hyphens, as in its address." } : {}),
    ...(!key ? { key: "The chat's key — data-key in the code Settings › Customer inbox gives." } : !CHAT_KEY_PATTERN.test(key) ? { key: "That isn't a chat key: copy data-key from the code Settings › Customer inbox gives." } : {}),
  };
}

/**
 * The workspace and key from the code a workspace's Settings › Customer inbox gives —
 * `<script src="https://deskzo.deskzo.com/api/inbox/public/widget.js" data-key="…" async></script>` —
 * the workspace being the first part of the address. Null when it isn't that code.
 */
export function chatFromSnippet(snippet: string): SiteChat | null {
  const src = /src\s*=\s*["']([^"']+)["']/i.exec(snippet)?.[1];
  const key = /data-key\s*=\s*["']([^"']+)["']/i.exec(snippet)?.[1];
  if (!src || !key) return null;
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.pathname !== "/api/inbox/public/widget.js") return null;
  const workspace = url.hostname.split(".")[0] ?? "";
  return SLUG_PATTERN.test(workspace) && CHAT_KEY_PATTERN.test(key) ? { workspace, key } : null;
}
