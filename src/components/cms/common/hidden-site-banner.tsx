import Link from "next/link";
import { Banner } from "@/components/console/kit/banner";
import { CMS_ROUTES } from "@/lib/cms/nav";
import { searchPolicy } from "@/lib/cms/search-policy";

/**
 * Said on the CMS's dashboard and SEO Intelligence while the whole public site is kept out of search
 * (Settings › Search & AI, or a staging installation): the scores still measure every page, but no
 * search engine lists any of them. Admins get the way to change it; nothing for anybody otherwise.
 */
export async function HiddenSiteBanner({ admin }: { admin: boolean }) {
  const policy = await searchPolicy();
  if (!policy.hidden) return null;
  return (
    <Banner
      tone="warning"
      title="The website is hidden from search"
      action={
        admin && !policy.forcedHidden ? (
          <Link href={CMS_ROUTES.search} className="font-medium text-brand hover:underline">
            Search & AI settings
          </Link>
        ) : undefined
      }
    >
      {policy.forcedHidden
        ? "This is a staging installation, so every page asks search engines not to list it, and no sitemap or llms.txt is served."
        : "Every page asks search engines not to list it, the sitemap and llms.txt are empty, and no AI crawler is let in."}
    </Banner>
  );
}
