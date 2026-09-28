"use client";

import { useSearchParams } from "next/navigation";
import { consoleExportCommissions } from "@/actions/platform/console-commissions";
import { ExportCsvButton } from "@/components/console/kit/export-button";

/**
 * A partner's Commissions tab as CSV — every status unless the tab's filter names one. The page that
 * holds the tab owns the address, so its filters are read from it here, and the partner is pinned.
 */
export function PartnerCommissionsExport({ slug }: { slug: string }) {
  const searchParams = useSearchParams();
  const params: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) if (value && key !== "page" && key !== "tab") params[key] = value;
  params.partner = slug;
  return <ExportCsvButton action={() => consoleExportCommissions(params, "partner")} />;
}
