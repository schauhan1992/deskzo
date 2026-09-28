import type { Metadata } from "next";
import { platformEnv } from "@/lib/platform/console-page";

/**
 * Every console page, signed in or not: its own title, and never in a search index. Pages give a plain
 * `title` ("Workspaces"); the template adds the product, and outside production a "[staging] " prefix,
 * so a tab left open on staging does not pass for the real thing.
 */
export function generateMetadata(): Metadata {
  const { titlePrefix } = platformEnv();
  return {
    title: { template: `${titlePrefix}%s · Wroffy console`, default: `${titlePrefix}Wroffy console` },
    robots: { index: false, follow: false },
  };
}

export default function PlatformConsoleRoot({ children }: LayoutProps<"/platform-console">) {
  return children;
}
