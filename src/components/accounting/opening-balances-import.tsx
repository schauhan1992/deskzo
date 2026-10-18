"use client";

import { useState } from "react";
import { commitOpeningBalances, openingBalancesTemplate, previewOpeningBalances } from "@/actions/opening-balances";
import { ImportDialog } from "@/components/settings/import-dialog";
import { Input, Label } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

/**
 * "Import opening balances" on the Journal (owner, 18 Oct 2026): a trial balance from Zoho Books or
 * anywhere else, posted as one entry on the day the books start. The entry is
 * src/lib/portability/opening-balances.ts.
 */
export function OpeningBalancesImport() {
  const clock = useClock();
  const [openingDate, setOpeningDate] = useState(() => `${clock.today().slice(0, 7)}-01`);
  const withDate = <T extends object>(file: T) => ({ ...file, openingDate });

  return (
    <ImportDialog
      areaKey="opening-balances"
      areaLabel="Opening balances"
      buttonLabel="Import opening balances"
      title="Import opening balances"
      actions={{ preview: (file) => previewOpeningBalances(withDate(file)), commit: (file) => commitOpeningBalances(withDate(file)), template: () => openingBalancesTemplate() }}
      intro={
        <div className="space-y-2 text-sm text-muted">
          <p>A trial balance from your old system, as of the day your books start in Deskzo — one row an account, posted as one journal entry.</p>
          <ul className="list-disc space-y-1 pl-5 text-xs">
            <li>Accounts are found by code, else by name: import your chart of accounts first.</li>
            <li>
              A Receivables or Payables row names its customer or vendor. Leave out anyone whose open invoices or bills you import —
              that import posts their balances.
            </li>
            <li>Any difference between debits and credits goes to Opening Balance Equity; the preview says how much.</li>
            <li>Importing again replaces the entry imported before: it&apos;s reversed, and both are kept.</li>
          </ul>
          <div className="space-y-1">
            <Label htmlFor="opening-balances-date">The day your books start in Deskzo</Label>
            <Input id="opening-balances-date" type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} className="w-48" />
          </div>
        </div>
      }
    />
  );
}
