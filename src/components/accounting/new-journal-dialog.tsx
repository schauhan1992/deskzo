"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { createManualJournal, type listAccounts } from "@/actions/ledger";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { accountTypeLabels } from "@/lib/ledger/chart";

type Account = Awaited<ReturnType<typeof listAccounts>>[number];

type Row = { key: string; accountId: string; debit: string; credit: string; narration: string };

const blank = (): Row => ({ key: crypto.randomUUID(), accountId: "", debit: "", credit: "", narration: "" });
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A hand-written entry — opening balances, depreciation, a correction the documents can't express.
 *
 * The running debit and credit totals are the point of the form: an accountant writes the lines they
 * know and watches the difference close, rather than submitting and being told it does not balance.
 */
export function NewJournalDialog({ accounts }: { accounts: Account[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
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

      <Dialog open={open} onClose={() => setOpen(false)} title="New journal entry">
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
                {rows.map((row, index) => (
                  <tr key={row.key} className="border-b border-line last:border-0">
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
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line bg-surface-sunken">
                  <td className="px-3 py-2 text-xs uppercase tracking-wide text-subtle">Total</td>
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
