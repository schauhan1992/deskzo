import Script from "next/script";
import { chatIsOn, type SiteChat } from "@/lib/platform/site-chat";
import { protocolFor } from "@/lib/tenancy/host";

/**
 * The chat bubble on every page of the public site (src/lib/platform/site-chat.ts): the Customer inbox's
 * own script, from the workspace named in the CMS's settings, on the platform's domain — the address is
 * made here, never stored. Loaded once the page is idle, so it never holds up the page; nothing at all when
 * the setting is empty. The workspace's channel must allow this site (its "Allowed sites"), or its empty
 * list allows any.
 */
export function SiteChatScript({ chat, workspaceSuffix }: { chat: SiteChat | undefined; workspaceSuffix: string }) {
  if (!chatIsOn(chat)) return null;
  const host = `${chat.workspace}${workspaceSuffix}`;
  return <Script id="site-chat" src={`${protocolFor(host)}://${host}/api/inbox/public/widget.js`} data-key={chat.key} strategy="lazyOnload" />;
}
