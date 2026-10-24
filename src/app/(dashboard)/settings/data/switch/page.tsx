import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SwitchToDeskzo } from "@/components/settings/migration/switch-to-deskzo";
import { can } from "@/lib/authz/resolve";
import { db } from "@/lib/db";
import { financialYearStartOf } from "@/lib/india-time";
import { compareMonths, listAdjustments } from "@/lib/migration/balances";
import { stepFiles } from "@/lib/migration/steps";
import { MIGRATION_SOURCES, latestMigration, openMigration } from "@/lib/migration/state";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { requireUser } from "@/lib/session";
import { indiaClock } from "@/lib/time/zone";

export const metadata: Metadata = { title: "Switch to Deskzo" };

/**
 * Settings › Import & export › Switch to Deskzo (owner, 24 Oct 2026; src/lib/migration): a company moving
 * partway through its financial year brings the year across, checks it month by month against the old
 * system, and finishes it. Whoever may post journals and import finance data; a 404 for anybody else.
 */
export default async function SwitchToDeskzoPage() {
  // Switched off or not in the plan says so; without the rights, the page isn't there (refused pages are 404).
  if (!(await isModuleEnabled("accounting"))) return <ModuleDisabledNotice moduleKey="accounting" />;
  const user = await requireUser();
  if (!(await can(user.id, "ledger.post")) || !(await can(user.id, "data.importFinance"))) notFound();

  const [migration, latest, canFinish] = await Promise.all([openMigration(), latestMigration().catch(() => null), can(user.id, "books.close")]);
  const [files, months, adjustments, accounts] = migration
    ? await Promise.all([
        stepFiles(migration),
        compareMonths(migration),
        listAdjustments(migration),
        db.ledgerAccount.findMany({ where: { isGroup: false, active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
      ])
    : [[], [], [], []];

  const today = indiaClock.today();
  const defaults = { yearStart: `${financialYearStartOf(new Date())}-04-01`, switchDate: `${today.slice(0, 7)}-01` };

  return (
    <div>
      <p className="text-xs text-muted">
        <Link href="/settings/data" className="hover:underline">
          Import &amp; export
        </Link>{" "}
        ›
      </p>
      <h1 className="text-xl font-semibold text-text">Switch to Deskzo partway through the year</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted">
        Bring the rest of this financial year across from the old system — every invoice, credit note and receipt on its own date with its own number — checked
        against the old system&apos;s books at every month end.
      </p>
      <div className="mt-6">
        <SwitchToDeskzo
          migration={migration}
          latest={latest}
          sources={MIGRATION_SOURCES}
          defaults={defaults}
          files={files}
          months={months}
          adjustments={adjustments}
          accounts={accounts}
          canFinish={canFinish}
        />
      </div>
    </div>
  );
}
