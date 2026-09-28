import type { Metadata } from "next";
import { SitePageView, sitePageMetadata } from "@/components/site/page-view";

/** Go to a workspace by name, or have its links emailed: "find my workspaces". */
export async function generateMetadata(): Promise<Metadata> {
  return sitePageMetadata("signin");
}

export default async function SigninPage({ searchParams }: PageProps<"/platform-site/signin">) {
  return <SitePageView slug="signin" searchParams={await searchParams} />;
}
