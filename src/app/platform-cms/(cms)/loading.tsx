import { PageSkeleton } from "@/components/console/kit/skeleton";

/** While a CMS page loads: the shape most of them arrive in — a header, a row of tiles, a list. */
export default function CmsLoading() {
  return <PageSkeleton kpis={4} rows={6} />;
}
