import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** Plans on sale for the visitor's country (?country=, ?interval=), read live from the control plane. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("pricing");
}

export default async function PricingPage({ searchParams }: PageProps<"/platform-site/pricing">) {
  return <SitePageView slug="pricing" searchParams={await searchParams} />;
}
