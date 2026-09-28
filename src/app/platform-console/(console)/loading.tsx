import { PageSkeleton } from "@/components/console/kit/skeleton";

/** While a console page loads: the shape most pages arrive in — header, four KPI tiles, a table. */
export default function ConsoleLoading() {
  return <PageSkeleton kpis={4} rows={8} />;
}
