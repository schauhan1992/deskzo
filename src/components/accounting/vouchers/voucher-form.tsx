"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import type { VoucherType } from "@prisma/client";
import { recentNarrations, saveVoucher, searchVoucherParties } from "@/actions/vouchers";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { CompanyCombobox, type CompanyComboOption } from "@/components/ui/company-combobox";
import { ActionNotice } from "@/components/ui/action-notice";
import { Dialog } from "@/components/ui/dialog";
import { focusedLine, shortcutNotice, useShortcuts } from "@/components/shortcuts/use-shortcuts";
import { copiedVoucher, copyVoucher, type VoucherCopy } from "@/lib/shortcuts/clipboard";
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
  // What the form held when it opened, to ask before leaving it changed (F5).
  const snapshot = () =>
    JSON.stringify({ type, date, narration, reference, party: party?.id ?? null, rows: rows.map((r) => [r.accountId, r.debit, r.credit, r.company?.id ?? null, r.departmentId, r.branchId, r.narration]) });
  const [pristine] = useState(snapshot);
  const [narrations, setNarrations] = useState<string[] | null>(null);
  const narrationRef = useRef<HTMLTextAreaElement>(null);
  const gridRef = useRef<HTMLTableSectionElement>(null);

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

  /** F7 / Alt + R: the focused column's value from the line above. */
  function repeatAbove() {
    const at = focusedLine();
    const row = at ? rows[at.index] : undefined;
    const above = at ? rows[at.index - 1] : undefined;
    if (!at || !row || !above || !at.field) return shortcutNotice("Nothing above to repeat.");
    const patch: Partial<Row> | null =
      at.field === "account"
        ? { accountId: above.accountId }
        : at.field === "debit"
          ? { debit: above.debit, ...(above.debit ? { credit: "" } : {}) }
          : at.field === "credit"
            ? { credit: above.credit, ...(above.credit ? { debit: "" } : {}) }
            : at.field === "party"
              ? { company: above.company }
              : at.field === "department"
                ? { departmentId: above.departmentId }
                : at.field === "branch"
                  ? { branchId: above.branchId }
                  : at.field === "narration"
                    ? { narration: above.narration }
                    : null;
    if (!patch) return shortcutNotice("Nothing above to repeat.");
    update(row.key, patch);
  }

  /** F9: the focused line goes, and the cursor moves to its neighbour. */
  function deleteFocusedLine() {
    const at = focusedLine();
    const gone = at ? rows[at.index] : undefined;
    if (!at || !gone) return shortcutNotice("Put the cursor on the line to delete.");
    if (rows.length <= 2) return shortcutNotice("A voucher keeps at least two lines.");
    setRows((current) => current.filter((r) => r.key !== gone.key));
    const next = Math.min(at.index, rows.length - 2);
    window.setTimeout(() => gridRef.current?.querySelector<HTMLElement>(`[data-line="${next}"] select, [data-line="${next}"] input`)?.focus(), 0);
  }

  /** F12: this voucher as it stands, to paste into a new one with Alt + F12. */
  function copyThis() {
    const used = rows.filter(filled);
    if (used.length === 0) return shortcutNotice("Nothing to copy yet — add the voucher's lines first.");
    const parties = new Map<string, Choice>();
    for (const c of [party, ...used.map((r) => r.company)]) if (c) parties.set(c.id, { id: c.id, name: c.name });
    const copy: VoucherCopy = {
      kind: "voucher",
      type,
      narration,
      reference,
      companyId: party?.id ?? null,
      lines: used.map((r) => ({ accountId: r.accountId, debit: r.debit, credit: r.credit, companyId: r.company?.id ?? null, departmentId: r.departmentId || null, branchId: r.branchId || null, narration: r.narration })),
      copiedFrom: initial?.number ?? "an unsaved voucher",
      copiedAt: new Date().toISOString(),
      parties: [...parties.values()],
    };
    shortcutNotice(copyVoucher(copy) ? "Copied — Alt + F12 on a new voucher fills it in." : "This browser won't keep a copy — its storage is turned off.");
  }

  /** Alt + F12: the voucher last copied, into this form — its lines whose accounts this form offers. */
  function pasteCopied() {
    const copy = copiedVoucher("voucher");
    if (!copy) return shortcutNotice("Nothing copied yet — F12 on a voucher copies it.");
    if (rows.some(filled) && !window.confirm(`Replace what's on this voucher with ${copy.copiedFrom}?`)) return;
    const names = new Map((copy.parties ?? []).map((p) => [p.id, p]));
    const choice = (id: string | null): Choice | null => (id ? (names.get(id) ?? knownParties.find((k) => k.id === id) ?? { id, name: "Copied party" }) : null);
    const usable = copy.lines.filter((l) => accounts.has(l.accountId)).slice(0, MAX_VOUCHER_LINES);
    const skipped = copy.lines.length - usable.length;
    const pasted: Row[] = usable.map((l) => ({
      key: crypto.randomUUID(),
      accountId: l.accountId,
      debit: l.debit ?? "",
      credit: l.credit ?? "",
      company: choice(l.companyId),
      departmentId: l.departmentId && options.departments.some((d) => d.id === l.departmentId) ? l.departmentId : "",
      branchId: l.branchId && options.branches.some((b) => b.id === l.branchId) ? l.branchId : "",
      narration: l.narration ?? "",
    }));
    while (pasted.length < 2) pasted.push(blank());
    const copiedType = (TYPES as string[]).includes(copy.type) ? (copy.type as VoucherType) : type;
    const kindKept = !!initial && copiedType !== type;
    if (!initial) setType(copiedType);
    setNarration(copy.narration ?? "");
    setReference(copy.reference ?? "");
    setParty(choice(copy.companyId));
    setRows(pasted);
    const unseen = [...names.values()].filter((p) => !knownParties.some((k) => k.id === p.id));
    if (unseen.length) setKnownParties((list) => [...list, ...unseen]);
    shortcutNotice(
      `Filled from ${copy.copiedFrom}: ${usable.length} line(s)` +
        (kindKept ? ` — this voucher stays a ${voucherTypeLabels[type].toLowerCase()} voucher` : "") +
        (skipped ? `; ${skipped} skipped — their accounts aren't offered here` : "") +
        ".",
    );
  }

  // BUSY's keys on a voucher's form (src/lib/shortcuts/busy.ts, scope "form").
  useShortcuts("form", {
    save: () => {
      if (pending) return;
      if (!touched) return shortcutNotice("Add the voucher's lines first.");
      if (problem) return shortcutNotice(problem);
      if (!narration.trim()) {
        narrationRef.current?.focus();
        return shortcutNotice("Write the narration — every voucher says what it's for.");
      }
      if (!date) return shortcutNotice("Pick the voucher's date.");
      save();
    },
    narration: () => {
      void recentNarrations(type).then((list) =>
        list.length ? setNarrations(list) : shortcutNotice("No narrations written yet — the ones you write are offered here next time."),
      );
    },
    "record-list": () => {
      if (snapshot() !== pristine && !window.confirm("Leave this voucher without saving it?")) return;
      router.push(`/accounting/vouchers?type=${type}`);
    },
    "change-type": () => {
      if (initial) return shortcutNotice(`A voucher keeps its kind — this one stays a ${voucherTypeLabels[type].toLowerCase()} voucher.`);
      const next = TYPES[(TYPES.indexOf(type) + 1) % TYPES.length]!;
      setType(next);
      shortcutNotice(`Now a ${voucherTypeLabels[next].toLowerCase()} voucher.`);
    },
    repeat: repeatAbove,
    "delete-row": deleteFocusedLine,
    "copy-voucher": copyThis,
    "paste-voucher": pasteCopied,
  });

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
            ref={narrationRef}
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
          <tbody ref={gridRef}>
            {rows.map((row, index) => {
              const account = accounts.get(row.accountId);
              const n = index + 1;
              return (
                <tr key={row.key} data-line={index} className="border-b border-line align-top last:border-0">
                  <td className="space-y-1.5 px-3 py-2">
                    <div data-field="account">
                      <Select aria-label={`Account, line ${n}`} value={row.accountId} onChange={(e) => update(row.key, { accountId: e.target.value })} className="h-9 min-w-[16rem]">
                        {accountOptions(row.accountId)}
                      </Select>
                    </div>
                    {account?.needsParty && (
                      <div data-field="party">
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
                      </div>
                    )}
                    <div data-field="narration">
                      <Input
                        aria-label={`Line ${n} narration`}
                        value={row.narration}
                        maxLength={200}
                        onChange={(e) => update(row.key, { narration: e.target.value })}
                        placeholder="Line narration (optional)"
                        className="h-8 text-xs"
                      />
                    </div>
                  </td>
                  {showDepartment && (
                    <td data-field="department" className="px-3 py-2">
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
                    <td data-field="branch" className="px-3 py-2">
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
                  <td data-field="debit" className="px-3 py-2">
                    <Input
                      aria-label={`Debit, line ${n}`}
                      inputMode="decimal"
                      value={row.debit}
                      onChange={(e) => update(row.key, { debit: e.target.value, ...(e.target.value ? { credit: "" } : {}) })}
                      className="h-9 text-right tabular-nums"
                      placeholder="0.00"
                    />
                  </td>
                  <td data-field="credit" className="px-3 py-2">
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
        <Button type="button" onClick={save} disabled={pending || !ready} title="Save (F2)" aria-keyshortcuts="F2">
          {pending ? "Saving…" : initial ? "Save changes" : "Save draft"}
        </Button>
      </div>
      <p className="text-right text-xs text-subtle">F2 save · F7 repeat · F9 delete line · F4 narration · F12 copy · Alt+F12 paste · ? all keys</p>

      {narrations && (
        <NarrationPicker
          options={narrations}
          onClose={() => setNarrations(null)}
          onPick={(text) => {
            setNarration(text);
            setNarrations(null);
            window.setTimeout(() => narrationRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}

/** F4: a narration written before, picked by typing a little of it and Enter — or by a click. */
function NarrationPicker({ options, onPick, onClose }: { options: string[]; onPick: (text: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const shown = options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()));
  const at = Math.min(active, Math.max(0, shown.length - 1));
  return (
    <Dialog open onClose={onClose} title="Standard narration">
      <div className="space-y-3">
        <Input
          autoFocus
          role="combobox"
          aria-label="Filter the narrations"
          aria-expanded
          aria-controls="vNarrationOptions"
          aria-activedescendant={shown[at] ? `vNarrationOption${at}` : undefined}
          value={query}
          placeholder="Type to filter…"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(at + 1, shown.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(at - 1, 0));
            } else if (e.key === "Enter" && shown[at]) {
              e.preventDefault();
              onPick(shown[at]);
            }
          }}
        />
        <ul id="vNarrationOptions" role="listbox" aria-label="Narrations written before" className="max-h-72 space-y-0.5 overflow-y-auto">
          {shown.map((text, i) => (
            <li
              key={text}
              id={`vNarrationOption${i}`}
              role="option"
              aria-selected={i === at}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(text);
              }}
              className={cn("cursor-pointer rounded-base px-3 py-2 text-sm", i === at ? "bg-brand-subtle text-brand" : "text-text hover:bg-surface-sunken")}
            >
              {text}
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-subtle">None match.</li>}
        </ul>
      </div>
    </Dialog>
  );
}
