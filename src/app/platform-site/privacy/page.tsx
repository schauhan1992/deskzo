import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** The draft privacy notice, for review by counsel. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("privacy");
}

export default async function PrivacyPage({ searchParams }: PageProps<"/platform-site/privacy">) {
  return <SitePageView slug="privacy" searchParams={await searchParams} />;
}
