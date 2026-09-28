import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** How each company's data is kept apart — from docs/privacy and docs/runbook.md. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("security");
}

export default async function SecurityPage({ searchParams }: PageProps<"/platform-site/security">) {
  return <SitePageView slug="security" searchParams={await searchParams} />;
}
