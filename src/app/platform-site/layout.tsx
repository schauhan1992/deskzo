import type { Metadata } from "next";
import { SiteShell, siteLayoutMetadata } from "@/components/site/page-view";

/**
 * The public website — the bare domain and www. (src/proxy.ts rewrites those hosts' paths into this
 * folder). Every page's words come from src/lib/platform/site-content.ts, and none reads a
 * workspace's data.
 */
export async function generateMetadata(): Promise<Metadata> {
  return siteLayoutMetadata();
}

export default function PlatformSiteLayout({ children }: LayoutProps<"/platform-site">) {
  return <SiteShell>{children}</SiteShell>;
}
