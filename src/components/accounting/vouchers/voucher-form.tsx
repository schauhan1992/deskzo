"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { VoucherType } from "@prisma/client";
import { saveVoucher, searchVoucherParties } from "@/actions/vouchers";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { ActionNotice } from "@/components/ui/action-notice";
import { entryTotalsPaise } from "@/lib/accounts/money";
import { MAX_VOUCHER_LINES, voucherProblem, voucherTypeHints, voucherTypeLabels, type AccountFacts, type VoucherLineInput } from "@/lib/accounts/vouchers";
import { cn, formatCurrency } from "@/lib/utils";

const TYPES: VoucherType[] = ["PAYMENT", "RECEIPT", "CONTRA", "JOURNAL"];

type Choice = { id: string; name: string };

export type VoucherFormOptions = {
  accounts: AccountFacts[];
  departments: Choice[];
  branches: Choice[];
};

export type VoucherFormInitial = {
  id: string;
  number: string;
  type: VoucherType;
  date: string;
  narration: string;
  reference: string;
  company: Choice | null;
  lines: {
    accountId: string;
    debit: number;
    credit: number;
    company: Choice | null;
    departmentId: string | null;
    branchId: string | null;
    narration: string | null;
  }[];
};

type Row = {
  key: string;
  accountId: string;
  debit: string;
  credit: string;
  company: Choice | null;
  departmentId: string;
  branchId: string;
  narration: string;
};

const blank = (): Row => ({ key: crypto.randomUUID(), accountId: "", debit: "", credit: "", company: null, departmentId: "", branchId: "", narration: "" });
const amountText = (n: number) => (n ? String(n) : "");

/** Whether a row has anything in it — a row left empty is not a line, and isn't sent. */
const filled = (r: Row) => !!r.accountId || !!Number(r.debit) || !!Number(r.credit);

/**
 * A voucher, written or rewritten while it's a draft (owner, 22 Oct 2026).
 *
 * The rules each kind keeps (src/lib/accounts/vouchers.ts) are checked as you type, the same function the
 * server runs before anything is saved, so the form says which line is wrong rather than refusing on save.
 * Bank and cash accounts are listed first; a contra offers only them, and a journal none of them. A
 * receivable or payable line asks whose. The form carries one token for its whole life, so pressing Save
 * twice — or a retry after a dropped connection — makes one voucher, not two.
 */
export function VoucherForm({ options, initial, initialType }: { options: VoucherFormOptions; initial?: VoucherFormInitial; initialType?: VoucherType }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());

  const [type, setType] = useState<VoucherType>(initial?.type ?? initialType ?? "PAYMENT");
  const [date, setDate] = useState(initial?.date ?? clock.today());
  const [narration, setNarration] = useState(initial?.narration ?? "");
  const [reference, setReference] = useState(initial?.reference ?? "");
  const [party, setParty] = useState<Choice | null>(initial?.company ?? null);
  const [rows, setRows] = useState<Row[]>(() =>
    initial?.lines.length
      ? initial.lines.map((l) => ({
          key: crypto.randomUUID(),
          accountId: l.accountId,
          debit: amountText(l.debit),
          credit: amountText(l.credit),
          company: l.company,
          departmentId: l.departmentId ?? "",
          branchId: l.branchId ?? "",
          narration: l.narration ?? "",
        }))
      : [blank(), blank()],
  );
  // Every party this form has seen, so a chosen one keeps its name in the picker.
  const [knownParties, setKnownParties] = useState<CompanyComboOption[]>(() => {
    const seen = new Map<string, Choice>();
    for (const c of [initial?.company, ...(initial?.lines.map((l) => l.company) ?? [])]) if (c) seen.set(c.id, c);
    return [...seen.values()];
  });
  const remember = (c: CompanyComboOption | null) => {
    if (c && !knownParties.some((k) => k.id === c.id)) setKnownParties((list) => [...list, { id: c.id, name: c.name }]);
  };

  const accounts = new Map(options.accounts.map((a) => [a.id, a]));
  const money = options.accounts.filter((a) => a.isMoney);
  const others = options.accounts.filter((a) => !a.isMoney);
  const showDepartment = options.departments.length > 0;
  const showBranch = options.branches.length > 1;

  const lines: VoucherLineInput[] = rows.filter(filled).map((r) => ({
    accountId: r.accountId,
    debit: Number(r.debit) || 0,
    credit: Number(r.credit) || 0,
    companyId: r.company?.id ?? null,
    departmentId: r.departmentId || null,
    branchId: r.branchId || null,
    narration: r.narration.trim() || null,
  }));
  const totals = entryTotalsPaise(lines);
  const difference = (totals.debit - totals.credit) / 100;
  const touched = rows.some(filled);
  const problem = touched ? voucherProblem(type, lines, accounts) : null;
  const ready = touched && !problem && narration.trim() !== "" && !!date;

  function update(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveVoucher({
        id: initial?.id,
        type,
        date,
        narration,
        reference,
        companyId: party?.id ?? null,
        lines,
        requestId: initial ? undefined : requestId,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/accounting/vouchers/${result.data.id}`);
      router.refresh();
    });
  }

  /** The accounts a line on this kind of voucher may use — none of a contra's are anything but bank or cash. */
  const accountOptions = (current: string) => {
    const groups =
      type === "CONTRA" ? [{ label: "Bank & cash", list: money }] : type === "JOURNAL" ? [{ label: "Accounts", list: others }] : [{ label: "Bank & cash", list: money }, { label: "Other accounts", list: others }];
    // A line already on an account this kind doesn't offer keeps it, so the problem shows rather than vanishing.
    const stray = current && !groups.some((g) => g.list.some((a) => a.id === current)) ? accounts.get(current) : undefined;
    return (
      <>
        <option value="">Select an account…</option>
        {stray && (
          <option value={stray.id}>
            {stray.code} — {stray.name}
          </option>
        )}
        {groups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </optgroup>
        ))}
      </>
    );
  };

  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <fieldset>
          <legend className="text-sm font-medium text-text">Kind</legend>
          {initial ? (
            <p className="mt-1 text-sm text-muted">
              {voucherTypeLabels[type]} voucher {initial.number} — a voucher keeps its kind.
            </p>
          ) : (
            <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
              {TYPES.map((t) => (
                <label
                  key={t}
                  className={cn(
                    "cursor-pointer rounded-base border px-3 py-2 text-sm transition-colors",
                    type === t ? "border-brand bg-brand-subtle" : "border-line hover:bg-surface-sunken",
                  )}
                >
                  <input type="radio" name="voucherType" value={t} checked={type === t} onChange={() => setType(t)} className="sr-only" />
                  <span className="font-medium text-text">{voucherTypeLabels[t]}</span>
                  <span className="mt-0.5 block text-xs text-muted">{voucherTypeHints[t]}</span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="vDate">Date</Label>
            <Input id="vDate" type="date" value={date} max={clock.today()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vReference">Reference</Label>
            <Input id="vReference" value={reference} maxLength={80} onChange={(e) => setReference(e.target.value)} placeholder="Cheque no., UTR, bill no." />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vParty">Party (optional)</Label>
            <CompanyCombobox
              id="vParty"
              companies={knownParties}
              value={party?.id ?? ""}
              search={searchVoucherParties}
              onSelect={(c) => {
                remember(c);
                setParty(c ? { id: c.id, name: c.name } : null);
              }}
              placeholder="Type to search vendors and customers…"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vNarration">Narration</Label>
          <Textarea
            id="vNarration"
            rows={2}
            maxLength={500}
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            placeholder={type === "PAYMENT" ? "Office rent for October" : type === "RECEIPT" ? "Interest credited by the bank" : type === "CONTRA" ? "Cash deposited into the current account" : "Provision for audit fees"}
          />
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Account</th>
              {showDepartment && <th className="w-44 px-3 py-2">Cost centre</th>}
              {showBranch && <th className="w-44 px-3 py-2">Branch</th>}
              <th className="w-36 px-3 py-2 text-right">Debit</th>
              <th className="w-36 px-3 py-2 text-right">Credit</th>
              <th className="w-10 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const account = accounts.get(row.accountId);
              const n = index + 1;
              return (
                <tr key={row.key} className="border-b border-line align-top last:border-0">
                  <td className="space-y-1.5 px-3 py-2">
                    <Select aria-label={`Account, line ${n}`} value={row.accountId} onChange={(e) => update(row.key, { accountId: e.target.value })} className="h-9 min-w-[16rem]">
                      {accountOptions(row.accountId)}
                    </Select>
                    {account?.needsParty && (
                      <CompanyCombobox
                        companies={knownParties}
                        value={row.company?.id ?? ""}
                        search={searchVoucherParties}
                        onSelect={(c) => {
                          remember(c);
                          update(row.key, { company: c ? { id: c.id, name: c.name } : null });
                        }}
                        placeholder={`Whose? ${account.name} needs a party`}
                        aria-invalid={!row.company}
                      />
                    )}
                    <Input
                      aria-label={`Line ${n} narration`}
                      value={row.narration}
                      maxLength={200}
                      onChange={(e) => update(row.key, { narration: e.target.value })}
                      placeholder="Line narration (optional)"
                      className="h-8 text-xs"
                    />
                  </td>
                  {showDepartment && (
                    <td className="px-3 py-2">
                      <Select aria-label={`Cost centre, line ${n}`} value={row.departmentId} onChange={(e) => update(row.key, { departmentId: e.target.value })} className="h-9">
                        <option value="">—</option>
                        {options.departments.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  )}
                  {showBranch && (
                    <td className="px-3 py-2">
                      <Select aria-label={`Branch, line ${n}`} value={row.branchId} onChange={(e) => update(row.key, { branchId: e.target.value })} className="h-9">
                        <option value="">—</option>
                        {options.branches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                  )}
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Debit, line ${n}`}
                      inputMode="decimal"
                      value={row.debit}
                      onChange={(e) => update(row.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })}
                      className="h-9 text-right tabular-nums"
                      placeholder="0.00"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Input
                      aria-label={`Credit, line ${n}`}
                      inputMode="decimal"
                      value={row.credit}
                      onChange={(e) => update(row.key, { credit: e.target.value, ...(e.target.value ? { debit: "" } : {}) })}
                      className="h-9 text-right tabular-nums"
                      placeholder="0.00"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove line ${n}`}
                      disabled={rows.length <= 2}
                      onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
                    >
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-line-strong">
              <td className="px-3 py-2.5" colSpan={1 + (showDepartment ? 1 : 0) + (showBranch ? 1 : 0)}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={rows.length >= MAX_VOUCHER_LINES}
                  onClick={() => setRows((current) => [...current, blank()])}
                >
                  <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  Add line
                </Button>
              </td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-text">{formatCurrency(totals.debit / 100)}</td>
              <td className="px-3 py-2.5 text-right font-semibold tabular-nums text-text">{formatCurrency(totals.credit / 100)}</td>
              <td />
            </tr>
            {difference !== 0 && (
              <tr>
                <td className="px-3 pb-2.5 text-right text-xs text-danger" colSpan={3 + (showDepartment ? 1 : 0) + (showBranch ? 1 : 0)}>
                  {difference > 0 ? "Debits" : "Credits"} are {formatCurrency(Math.abs(difference))} more
                </td>
                <td />
              </tr>
            )}
          </tfoot>
        </table>
      </Card>

      {problem && <ActionNotice tone="info">{problem}</ActionNotice>}
      {error && <ActionNotice tone="error">{error}</ActionNotice>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link
          href={initial ? `/accounting/vouchers/${initial.id}` : "/accounting/vouchers"}
          className="inline-flex h-9 items-center rounded-base px-3.5 text-sm font-medium text-muted hover:bg-surface-sunken hover:text-text"
        >
          Cancel
        </Link>
        <Button type="button" onClick={save} disabled={pending || !ready}>
          {pending ? "Saving…" : initial ? "Save changes" : "Save draft"}
        </Button>
      </div>
    </div>
  );
}
