import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** The draft terms: the data processing agreement, for review by counsel. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("terms");
}

export default async function TermsPage({ searchParams }: PageProps<"/platform-site/terms">) {
  return <SitePageView slug="terms" searchParams={await searchParams} />;
}
