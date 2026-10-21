import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { receivablesAgingReport } from "@/actions/receivable";
import { AgingPrint } from "@/components/receivables/aging-print";
import { getOrganisation } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import type { AgingParams } from "@/lib/receivables/aging";

/** The AR aging report on paper (src/components/receivables/aging-print.tsx), with the settings the screen had. */
export default async function PrintReceivablesAgingPage({ searchParams }: { searchParams: Promise<AgingParams> }) {
  if (!(await isModuleEnabled("receivables"))) notFound();
  const [report, org, clock] = await Promise.all([receivablesAgingReport({ ...(await searchParams), party: undefined, col: undefined }), getOrganisation(), workspaceClock()]);
  if (!report) notFound();
  return <AgingPrint report={report} company={org.tradeName || org.legalName} printedAt={clock.dateTime(new Date())} />;
}
