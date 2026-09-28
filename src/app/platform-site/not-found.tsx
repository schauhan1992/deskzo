import { SiteNotFoundView } from "@/components/site/page-view";

/** An address the public site has no page for, inside the site's own header and footer. */
export default async function SiteNotFound() {
  return <SiteNotFoundView />;
}
