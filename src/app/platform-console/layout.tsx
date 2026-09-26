import type { Metadata } from "next";

/** Every console page, signed in or not: its own title, and never in a search index. */
export const metadata: Metadata = { title: "Platform console", robots: { index: false, follow: false } };

export default function PlatformConsoleRoot({ children }: LayoutProps<"/platform-console">) {
  return children;
}
