import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** The contact form (?topic=demo|sales|support|other) — src/actions/platform/site.ts sendContactRequest. */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("contact");
}

export default async function ContactPage({ searchParams }: PageProps<"/platform-site/contact">) {
  return <SitePageView slug="contact" searchParams={await searchParams} />;
}
