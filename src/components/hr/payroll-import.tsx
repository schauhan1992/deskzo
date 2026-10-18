"use client";

import Link from "next/link";
import { commitPayrollImport, payrollImportTemplate, previewPayrollImport } from "@/actions/payroll-import";
import { ImportDialog } from "@/components/settings/import-dialog";

/**
 * "Import from another system" on the payroll page, for payroll only (roadmap 1.13; owner, 18 Oct 2026):
 * salaries, bank and statutory numbers, and this tax year's pay so far, one row a person. The rows are
 * src/lib/portability/importers/payroll.ts.
 */
export function PayrollImport() {
  return (
    <ImportDialog
      areaKey="payroll"
      areaLabel="Pay"
      buttonLabel="Import from another system"
      title="Bring pay across from another system"
      actions={{ preview: previewPayrollImport, commit: commitPayrollImport, template: payrollImportTemplate }}
      intro={
        <div className="space-y-2 text-sm text-muted">
          <p>
            One row a person, found by their employee code or email — import People first. An export from Kredily, Keka or greytHR
            usually loads as it is once its extra columns are deleted: the usual headings are read as Deskzo&apos;s.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            <li>
              <strong className="text-text">Salary:</strong> the monthly gross, the day it starts, and the components Deskzo has (basic,
              HRA, conveyance, medical, special, other). Anything else in the gross goes into Other allowance.
            </li>
            <li>
              <strong className="text-text">Bank and statutory numbers:</strong> account, IFSC, PAN, UAN, PF and ESIC numbers. Of
              Aadhaar only the last four digits are kept. Format long numbers as text before exporting, or Excel shortens them.
            </li>
            <li>
              <strong className="text-text">Switching mid-year:</strong> this tax year&apos;s gross, TDS, PT and PF paid in the old
              system, so Deskzo works out the rest of the year&apos;s TDS.
            </li>
          </ul>
          <p className="text-xs">
            Leave balances go in separately, at{" "}
            <Link href="/people/leave/opening" className="text-brand hover:underline">
              Leave › Opening balances
            </Link>
            .
          </p>
        </div>
      }
    />
  );
}
