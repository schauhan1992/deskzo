import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** The public website's home page, at the bare domain. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("home");
}

export default async function PlatformHome({ searchParams }: PageProps<"/platform-site">) {
  return <SitePageView slug="home" searchParams={await searchParams} />;
}
