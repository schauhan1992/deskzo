import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { payablesAgingReport } from "@/actions/payable";
import { AgingPrint } from "@/components/receivables/aging-print";
import { getOrganisation } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import type { AgingParams } from "@/lib/receivables/aging";

/** The AP aging report on paper (src/components/receivables/aging-print.tsx), with the settings the screen had. */
export default async function PrintPayablesAgingPage({ searchParams }: { searchParams: Promise<AgingParams> }) {
  if (!(await isModuleEnabled("payables"))) notFound();
  const [report, org, clock] = await Promise.all([payablesAgingReport({ ...(await searchParams), party: undefined, col: undefined }), getOrganisation(), workspaceClock()]);
  if (!report) notFound();
  return <AgingPrint report={report} company={org.tradeName || org.legalName} printedAt={clock.dateTime(new Date())} />;
}
