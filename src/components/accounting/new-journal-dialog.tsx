"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { createManualJournal, type listAccounts } from "@/actions/ledger";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { cn, formatCurrency } from "@/lib/utils";
import { indiaClock } from "@/lib/time/zone";
import { accountTypeLabels } from "@/lib/ledger/chart";
import { branchLabel, type BranchChoice, type RegistrationChoice } from "@/lib/branches/format";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];

type Row = {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  narration: string;
  branchId: string;
  gstRegistrationId: string;
};

const blank = (): Row => ({
  key: crypto.randomUUID(),
  accountId: "",
  debit: "",
  credit: "",
  narration: "",
  branchId: "",
  gstRegistrationId: "",
});
const round2 = (n: number) => Math.round(n * 100) / 100;

/** The input and output tax accounts — a line on one belongs to one GSTIN's return (spec §8.3). */
const isGstAccount = (account: Account | undefined) => /^(INPUT|OUTPUT)_/.test(account?.systemKey ?? "");

/**
 * A hand-written entry — opening balances, depreciation, a correction the documents can't express.
 *
 * The running debit and credit totals are the point of the form: an accountant writes the lines they
 * know and watches the difference close, rather than submitting and being told it does not balance.
 *
 * With more than one branch, each line may say which branch it belongs to (the P&L by branch reads
 * it); with more than one GST registration, which GSTIN — and a line on a GST account must, or it
 * would land in no return or the wrong one. Neither column appears for a company with one of each,
 * where the server fills in the only answer there is.
 */
export function NewJournalDialog({
  accounts,
  branches = [],
  registrations = [],
}: {
  accounts: Account[];
  /** Active branches. */
  branches?: Pick<BranchChoice, "id" | "name" | "code" | "isHeadOffice">[];
  /** Active registrations. */
  registrations?: Pick<RegistrationChoice, "id" | "gstin" | "code">[];
}) {
  const router = useRouter();
  const showBranch = branches.length > 1;
  const showRegistration = registrations.length > 1;
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Today in India, not UTC's today: the books keep India's calendar in every workspace.
  const [date, setDate] = useState(() => indiaClock.today());
  const [narration, setNarration] = useState("");
  const [source, setSource] = useState<"MANUAL" | "OPENING">("MANUAL");
  const [rows, setRows] = useState<Row[]>([blank(), blank()]);

  const totals = rows.reduce(
    (t, r) => ({ debit: round2(t.debit + (Number(r.debit) || 0)), credit: round2(t.credit + (Number(r.credit) || 0)) }),
    { debit: 0, credit: 0 },
  );
  const difference = round2(totals.debit - totals.credit);
  const balanced = difference === 0 && totals.debit > 0;

  function update(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await createManualJournal({
        date,
        narration,
        source,
        lines: rows.map((r) => ({
          accountId: r.accountId,
          debit: r.debit,
          credit: r.credit,
          narration: r.narration,
          // Sent only when the column is shown; otherwise the server decides (the one GSTIN there is, or none).
          branchId: showBranch ? r.branchId || undefined : undefined,
          gstRegistrationId: showRegistration ? r.gstRegistrationId || undefined : undefined,
        })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setNarration("");
      setRows([blank(), blank()]);
      router.refresh();
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        New journal entry
      </Button>

      {/* Each tag column needs room beside the account and the two amounts; both need the wide card. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New journal entry"
        wide={showBranch && showRegistration}
        large={showBranch || showRegistration}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="jvDate">Date</Label>
              <Input id="jvDate" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="jvNarration">Narration</Label>
              <Input
                id="jvNarration"
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                placeholder="Depreciation for the quarter"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="jvSource">Kind</Label>
            <Select id="jvSource" value={source} onChange={(e) => setSource(e.target.value as "MANUAL" | "OPENING")}>
              <option value="MANUAL">Manual entry</option>
              <option value="OPENING">Opening balance</option>
            </Select>
          </div>

          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-3 py-2">Account</th>
                  {showBranch && <th className="w-44 px-3 py-2">Branch</th>}
                  {showRegistration && <th className="w-56 px-3 py-2">GSTIN</th>}
                  <th className="w-32 px-3 py-2 text-right">Debit</th>
                  <th className="w-32 px-3 py-2 text-right">Credit</th>
                  <th className="w-10 px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {/*
                  Named one by one rather than from the column headings: a heading names the column,
                  and one id shared down the rows would tie every label to the first line.
                */}
                {rows.map((row, index) => {
                  // A GST line with no GSTIN is refused on save once there is more than one registration;
                  // said here, beside the line, rather than only after posting.
                  const gstLine = isGstAccount(accountsById.get(row.accountId));
                  const needsRegistration = showRegistration && gstLine && !row.gstRegistrationId;
                  // Top-aligned only when a line can grow that hint under its GSTIN.
                  return (
                    <tr key={row.key} className={cn("border-b border-line last:border-0", showRegistration && "align-top")}>
                      <td className="px-3 py-2">
                        <Select
                          aria-label={`Account, line ${index + 1}`}
                          value={row.accountId}
                          onChange={(e) => update(row.key, { accountId: e.target.value })}
                          className="h-9"
                        >
                          <option value="">Select an account…</option>
                          {accounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} — {a.name} ({accountTypeLabels[a.type]})
                            </option>
                          ))}
                        </Select>
                      </td>
                      {showBranch && (
                        <td className="px-3 py-2">
                          <Select
                            id={`jv-branch-${row.key}`}
                            aria-label={`Branch, line ${index + 1}`}
                            value={row.branchId}
                            onChange={(e) => update(row.key, { branchId: e.target.value })}
                            className="h-9"
                          >
                            {/* Optional: a line with no branch is reported as "not attributed to a branch". */}
                            <option value="">—</option>
                            {branches.map((b) => (
                              <option key={b.id} value={b.id}>
                                {branchLabel(b)}
                              </option>
                            ))}
                          </Select>
                        </td>
                      )}
                      {showRegistration && (
                        <td className="px-3 py-2">
                          <Select
                            id={`jv-gstin-${row.key}`}
                            aria-label={`GSTIN, line ${index + 1}`}
                            aria-required={gstLine || undefined}
                            aria-describedby={needsRegistration ? `jv-gstin-${row.key}-hint` : undefined}
                            value={row.gstRegistrationId}
                            onChange={(e) => update(row.key, { gstRegistrationId: e.target.value })}
                            className={cn("h-9 font-mono text-xs", needsRegistration && "border-warning")}
                          >
                            <option value="">{gstLine ? "Choose a GSTIN…" : "—"}</option>
                            {registrations.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.code} · {r.gstin}
                              </option>
                            ))}
                          </Select>
                          {needsRegistration && (
                            <p id={`jv-gstin-${row.key}-hint`} className="mt-1 text-xs text-warning">
                              Required on a GST account — it decides whose return the line is in.
                            </p>
                          )}
                        </td>
                      )}
                      <td className="px-3 py-2">
                        <Input
                          aria-label={`Debit, line ${index + 1}`}
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.debit}
                          // A line is one side or the other, so typing in one clears the other rather
                          // than letting both be filled and rejected on save.
                          onChange={(e) => update(row.key, { debit: e.target.value, credit: "" })}
                          className="h-9 text-right"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          aria-label={`Credit, line ${index + 1}`}
                          type="number"
                          step="0.01"
                          min="0"
                          value={row.credit}
                          onChange={(e) => update(row.key, { credit: e.target.value, debit: "" })}
                          className="h-9 text-right"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          aria-label="Remove line"
                          disabled={rows.length <= 2}
                          onClick={() => setRows((c) => c.filter((r) => r.key !== row.key))}
                          className="rounded-base p-1 text-subtle hover:bg-surface-sunken hover:text-danger disabled:opacity-40"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-sunken">
                  <td
                    colSpan={showBranch || showRegistration ? 1 + Number(showBranch) + Number(showRegistration) : undefined}
                    className="px-3 py-2 text-xs uppercase tracking-wide text-subtle"
                  >
                    Total
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums text-text">
                    {formatCurrency(totals.debit)}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums text-text">
                    {formatCurrency(totals.credit)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button size="sm" variant="secondary" onClick={() => setRows((c) => [...c, blank()])}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add line
            </Button>
            <span className={`text-sm ${balanced ? "text-success" : "text-warning"}`}>
              {balanced
                ? "Balanced."
                : totals.debit === 0 && totals.credit === 0
                  ? "Enter the amounts."
                  : `Out by ${formatCurrency(Math.abs(difference))} — ${difference > 0 ? "credits" : "debits"} are short.`}
            </span>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            <Button disabled={!balanced || pending || !narration.trim()} onClick={save}>
              {pending ? "Posting…" : "Post entry"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
