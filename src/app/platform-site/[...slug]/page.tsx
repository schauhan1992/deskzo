import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/**
 * Any other address on the public site: a page the CMS added (src/lib/platform/site-content.ts), or
 * the site's own not-found page. The built-in pages have routes of their own, which win over this.
 */
const reserved = (slug: string) => slug === "home";

export async function generateMetadata({ params }: PageProps<"/platform-site/[...slug]">): Promise<Metadata> {
  const slug = (await params).slug.join("/").toLowerCase();
  return sitePageMetadata(reserved(slug) ? "" : slug);
}

export default async function SiteContentPage({ params, searchParams }: PageProps<"/platform-site/[...slug]">) {
  const slug = (await params).slug.join("/");
  if (reserved(slug) || slug !== slug.toLowerCase()) notFound();
  return <SitePageView slug={slug} searchParams={await searchParams} />;
}
