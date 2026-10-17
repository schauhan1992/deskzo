import Link from "next/link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { leaveOpeningSheet } from "@/actions/leave-openings";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { LeaveOpeningsSheet } from "@/components/hr/leave-openings-sheet";

/**
 * Opening leave balances, for a company moving to Deskzo partway through a year (owner, 17 Oct 2026).
 * HR only; anyone else gets a 404, like every refused page.
 */
export default async function LeaveOpeningPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const { year } = await searchParams;
  const sheet = await leaveOpeningSheet(year ? Number(year) : undefined);
  if (!sheet) notFound();

  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <Link href="/people/leave" className="text-sm text-muted hover:text-text">
          ← Leave
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">Opening balances — {sheet.label}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Moving to Deskzo partway through the year? For each person, type what they carried into {sheet.label} in your old system and what they&apos;d already taken this year
          before Deskzo. Deskzo still grants this year&apos;s leave from its first day, so with these two the balances match what your old system showed. A carried figure
          left empty is worked out from last year here, as usual.
        </p>
      </div>
      <LeaveOpeningsSheet sheet={sheet} />
    </div>
  );
}
