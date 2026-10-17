import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/**
 * The Help Center — every module's guide, grouped and searchable (src/lib/help/guides.ts). Each guide
 * is a CMS page at /help/<guide>, served by the site's catch-all route like any page the CMS added.
 */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("help");
}

export default async function HelpCenterPage({ searchParams }: PageProps<"/platform-site/help">) {
  return <SitePageView slug="help" searchParams={await searchParams} />;
}
