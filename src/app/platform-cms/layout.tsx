import type { Metadata } from "next";
import { platformEnv } from "@/lib/platform/console-page";

/**
 * Every page of the website CMS (cms.<domain>), signed in or not: its own title, and never in a
 * search index or followed by a crawler (the proxy says noindex in a header too). Pages give a plain
 * `title` ("Dashboard"); the template adds the product and, outside production, a "[staging] "
 * prefix, so a tab left open on staging does not pass for the real thing.
 */
export function generateMetadata(): Metadata {
  const { titlePrefix } = platformEnv();
  return {
    title: { template: `${titlePrefix}%s · Wroffy CMS`, default: `${titlePrefix}Wroffy CMS` },
    robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  };
}

export default function PlatformCmsRoot({ children }: LayoutProps<"/platform-cms">) {
  return children;
}
