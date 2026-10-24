"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import { CircleAlert, CircleCheck, Download, LoaderCircle, Upload } from "lucide-react";
import {
  addMigrationAdjustment,
  checkMigrationPart,
  finishMigrationAction,
  importMigrationPart,
  migrationTemplate,
  startMigrationAction,
  undoMigrationAction,
  uploadMigrationBalances,
  uploadMigrationFile,
} from "@/actions/migration";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";

/**
 * Settings › Import & export › Switch to Deskzo (src/lib/migration): one screen from choosing the old system
 * to a finished, locked year. The steps run in order — the year's start; invoices, credit notes, receipts;
 * bills, vendor credits, vendor payments; expenses and manual journals; then the month-end check — and each
 * file goes in a part at a time, so a big year shows its progress and a closed tab carries on where it stopped.
 */

type MigrationRow = { id: string; source: string; yearStart: string; switchDate: string; status: "OPEN" | "FINISHED" | "UNDONE"; counts: Record<string, number> };
type StepFile = { id: string; step: string; filename: string; units: number; done: number; failures: { line: number; key: string; error: string }[] };
type MonthCheck = { month: string; uploaded: boolean; agrees: boolean; accounts: number; differences: { accountId: string; code: string; name: string; deskzo: number; old: number; difference: number }[] };
type Adjustment = { id: string; entryNumber: string; date: string; reason: string; amount: number; debit: { code: string; name: string } | null; credit: { code: string; name: string } | null };
type Account = { id: string; code: string; name: string };

const STEPS = [
  { key: "invoices", label: "Invoices", units: "invoices", hint: "Every invoice from the start of the year to the day before the switch, paid or not — one row a line, as Zoho Books exports them. Void and draft ones are left behind." },
  { key: "credit-notes", label: "Credit notes", units: "credit notes", hint: "Each names the invoice it reduces, which must already be here. It's applied to that invoice — by the amount the file says, else by what the invoice still owed." },
  { key: "receipts", label: "Customer receipts", units: "payments", hint: "One row an invoice a payment paid, as Zoho Books exports customer payments. What isn't applied to an invoice stays on account." },
  {
    key: "bills",
    label: "Bills",
    units: "bills",
    hint: "Every vendor bill in the year, one row a line. Each line goes to the account the old system posted it to (Account), Purchases when blank — so add any account Deskzo's chart lacks first. Numbered in Deskzo's bill series; the vendor's own number is kept as the reference. TDS at the file's rate.",
  },
  { key: "vendor-credits", label: "Vendor credits", units: "vendor credits", hint: "Credits and debit notes from vendors, one row a line, each to its account (Purchase Rebates when blank). Set against the bill each names, by the vendor's number for it." },
  { key: "vendor-payments", label: "Vendor payments", units: "vendor payments", hint: "One row a bill a payment settled, as Zoho Books exports vendor payments; what isn't applied stays as an advance. Paid through the bank account named, or cash." },
  { key: "expenses", label: "Expenses", units: "expenses", hint: "What was paid without a bill — rent, travel, subscriptions — each as a payment voucher: its expense account, its input tax, and the account it was paid through." },
  {
    key: "journals",
    label: "Manual journals",
    units: "journals",
    hint: "Journals written by hand, one row a line, each as a voucher of its kind. Anything else the old system posted that no file here brings — a fund transfer, a deposit, a stock adjustment — can go in this file, so the months agree.",
  },
] as const;

const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A balance as an accountant reads one: the amount, then Dr or Cr. */
const drCr = (n: number) => (Math.abs(n) < 0.005 ? "—" : `${money(Math.abs(n))} ${n > 0 ? "Dr" : "Cr"}`);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

function readFile(f: File): Promise<{ filename: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ filename: f.name, base64: String(reader.result).split(",")[1] ?? "" });
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(f);
  });
}

async function downloadTemplate(step: string, setError: (e: string | null) => void) {
  const result = await migrationTemplate(step);
  if (!result.ok) return setError(result.error);
  const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = result.data.filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function SwitchToDeskzo(props: {
  migration: MigrationRow | null;
  latest: MigrationRow | null;
  sources: { value: string; label: string }[];
  defaults: { yearStart: string; switchDate: string };
  files: StepFile[];
  months: MonthCheck[];
  adjustments: Adjustment[];
  accounts: Account[];
  canFinish: boolean;
  /** The steps the plan has room for (src/lib/migration/steps.ts `stepsInPlan`). */
  steps: string[];
}) {
  if (!props.migration) return <StartForm sources={props.sources} defaults={props.defaults} latest={props.latest} />;
  const m = props.migration;
  const agreed = props.months.length > 0 && props.months.every((x) => x.agrees);
  const steps = STEPS.filter((s) => props.steps.includes(s.key));
  // The month-end check comes after the start and the steps.
  const checkSection = steps.length + 2;
  return (
    <div className="space-y-5">
      <Summary migration={m} sources={props.sources} />
      <Section number={1} title="The start of the year" done={false}>
        <p className="text-sm text-text">Bring what the company had on {dayLabel(m.yearStart)} first, with today&apos;s imports, starting the books on {dayLabel(m.yearStart)}:</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
          <li>
            Its balances: the trial balance as on the day before, from{" "}
            <Link href="/accounting/journal" className="text-brand hover:underline">
              Accounting › Journal › Import opening balances
            </Link>
            .
          </li>
          <li>
            Invoices from before {dayLabel(m.yearStart)} still unpaid on it, with what was left on them then, from{" "}
            <Link href="/sales/invoices" className="text-brand hover:underline">
              Sales › Tax Invoices › Import
            </Link>{" "}
            — and those customers left out of the trial balance&apos;s party rows.
          </li>
          <li>
            Bills from before {dayLabel(m.yearStart)} still unpaid on it, the same way, from{" "}
            <Link href="/purchase/bills" className="text-brand hover:underline">
              Purchase › Vendor bills › Import
            </Link>
            .
          </li>
        </ul>
      </Section>
      {steps.map((s, i) => (
        <StepCard key={s.key} number={i + 2} step={s} file={props.files.find((f) => f.step === s.key) ?? null} count={m.counts[s.key] ?? 0} />
      ))}
      <BalancesCard number={checkSection} months={props.months} />
      <DifferencesCard number={checkSection + 1} months={props.months} adjustments={props.adjustments} accounts={props.accounts} />
      <FinishCard number={checkSection + 2} migration={m} agreed={agreed} canFinish={props.canFinish} />
    </div>
  );
}

function Section({ number, title, done, children, actions }: { number: number; title: string; done: boolean; children: ReactNode; actions?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
          <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-surface-sunken text-[11px] text-muted" aria-hidden="true">
            {number}
          </span>
          {title}
          {done && <CircleCheck className="h-4 w-4 text-success" aria-label="Done" />}
        </h2>
        {actions}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function StartForm({ sources, defaults, latest }: { sources: { value: string; label: string }[]; defaults: { yearStart: string; switchDate: string }; latest: MigrationRow | null }) {
  const router = useRouter();
  const [source, setSource] = useState(sources[0]?.value ?? "zoho-books");
  const [yearStart, setYearStart] = useState(defaults.yearStart);
  const [switchDate, setSwitchDate] = useState(defaults.switchDate);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-text">Bring this financial year across</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted">
          For a company moving to Deskzo partway through its year. Its invoices, credit notes and receipts come across on their own dates with their own
          numbers, and every month is checked against the old system&apos;s trial balance. Until it&apos;s finished, Undo takes all of it back.
        </p>
        {latest && latest.status !== "OPEN" && (
          <p className="text-xs text-muted">
            The last one, {dayLabel(latest.yearStart)} to {dayLabel(latest.switchDate)}, was {latest.status === "FINISHED" ? "finished" : "undone"}.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="mig-source">Moving from</Label>
            <Select id="mig-source" value={source} onChange={(e) => setSource(e.target.value)}>
              {sources.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mig-year">The year started on</Label>
            <Input id="mig-year" type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mig-switch">First day in Deskzo</Label>
            <Input id="mig-switch" type="date" value={switchDate} onChange={(e) => setSwitchDate(e.target.value)} />
            <p className="text-xs text-muted">The first of a month.</p>
          </div>
        </div>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await startMigrationAction({ source, yearStart, switchDate });
              if (!r.ok) return setError(r.error);
              router.refresh();
            })
          }
        >
          {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
          Start
        </Button>
      </CardContent>
    </Card>
  );
}

function Summary({ migration, sources }: { migration: MigrationRow; sources: { value: string; label: string }[] }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const brought = Object.entries(migration.counts).filter(([, n]) => n > 0);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-warning/40 bg-warning-bg/40 px-4 py-3">
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium text-text">
          Bringing {dayLabel(migration.yearStart)} to the day before {dayLabel(migration.switchDate)} across from {sources.find((s) => s.value === migration.source)?.label ?? migration.source}
        </p>
        <p className="text-xs text-muted">
          {brought.length ? `So far: ${brought.map(([k, n]) => `${n.toLocaleString("en-IN")} ${STEPS.find((s) => s.key === k)?.units ?? k.replace(/-/g, " ")}`).join(", ")}. ` : "Nothing brought yet. "}
          Accounting reports say their figures aren&apos;t final until it&apos;s finished.
        </p>
      </div>
      <Button type="button" variant="ghost" size="sm" className="text-danger hover:bg-danger-bg hover:text-danger" onClick={() => setConfirming(true)}>
        Undo all of it
      </Button>
      <Dialog open={confirming} onClose={() => !pending && setConfirming(false)} title="Undo the migration">
        <div className="space-y-4">
          <p className="text-sm text-text">Every invoice, bill, credit, payment, expense, journal and entry it brought is taken back, and it&apos;s marked undone. You can start again after.</p>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Keep it
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await undoMigrationAction();
                  if (!r.ok) return setError(r.error);
                  setConfirming(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Undo all of it
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

type Outcome = { kind: "create"; label: string; detail: string } | { kind: "skip"; label: string; why: string } | { kind: "error"; label: string; line: number; error: string };

function StepCard({ number, step, file: initial, count }: { number: number; step: (typeof STEPS)[number]; file: StepFile | null; count: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<StepFile | null>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ creates: number; skips: number; errors: { line: number; label: string; error: string }[] } | null>(null);
  const [failures, setFailures] = useState(initial?.failures ?? []);
  const done = !!file && file.done >= file.units;

  const upload = async (f: File) => {
    setError(null);
    setChecked(null);
    setBusy("Reading the file…");
    try {
      const r = await uploadMigrationFile(step.key, await readFile(f));
      if (!r.ok) return setError(r.error);
      setFile({ id: r.data.fileId, step: step.key, filename: f.name, units: r.data.units, done: 0, failures: [] });
      setFailures([]);
      if (r.data.unknown.length) setError(`Columns not read: ${r.data.unknown.join(", ")}. Check the headings against the template.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That file couldn't be read.");
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!file) return;
    setError(null);
    const tally = { creates: 0, skips: 0, errors: [] as { line: number; label: string; error: string }[] };
    for (let offset = 0; offset < file.units; ) {
      setBusy(`Checking ${offset.toLocaleString("en-IN")} of ${file.units.toLocaleString("en-IN")}…`);
      const r = await checkMigrationPart(file.id, offset);
      if (!r.ok) {
        setBusy(null);
        return setError(r.error);
      }
      for (const o of r.data.outcomes as Outcome[]) {
        if (o.kind === "create") tally.creates += 1;
        else if (o.kind === "skip") tally.skips += 1;
        else tally.errors.push({ line: o.line, label: o.label, error: o.error });
      }
      offset = r.data.next;
    }
    setChecked(tally);
    setBusy(null);
  };

  const importAll = async () => {
    if (!file) return;
    setError(null);
    let current = file;
    while (current.done < current.units) {
      setBusy(`Bringing ${current.done.toLocaleString("en-IN")} of ${current.units.toLocaleString("en-IN")} across…`);
      const r = await importMigrationPart(current.id);
      if (!r.ok) {
        setBusy(null);
        return setError(r.error);
      }
      current = { ...current, done: r.data.done };
      setFile(current);
      setFailures(r.data.failed);
    }
    setBusy(null);
    router.refresh();
  };

  return (
    <Section
      number={number}
      title={step.label}
      done={done && failures.length === 0}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => downloadTemplate(step.key, setError)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Template
        </Button>
      }
    >
      <p className="text-sm text-muted">{step.hint}</p>
      {count > 0 && <p className="mt-1 text-xs text-text">{count.toLocaleString("en-IN")} {step.units} brought across so far.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".csv,.xlsx" className="sr-only" aria-label={`Upload the ${step.units}`} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => input.current?.click()}>
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {file ? "Upload again" : "Upload file"}
        </Button>
        {file && !done && (
          <>
            <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={check}>
              Check
            </Button>
            <Button type="button" size="sm" disabled={!!busy || (checked !== null && checked.errors.length > 0 && checked.creates === 0)} onClick={importAll}>
              {file.done > 0 ? "Carry on" : "Bring them across"}
            </Button>
          </>
        )}
        {file && (
          <span className="text-xs text-muted">
            {file.filename}: {file.done.toLocaleString("en-IN")} of {file.units.toLocaleString("en-IN")} {step.units} gone through
          </span>
        )}
      </div>
      <div aria-live="polite" className="mt-2 space-y-2">
        {busy && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            {busy}
          </p>
        )}
        {checked && (
          <p className="text-xs text-text">
            Checked: {checked.creates.toLocaleString("en-IN")} to bring, {checked.skips.toLocaleString("en-IN")} left out or already here,{" "}
            <span className={checked.errors.length ? "text-danger" : ""}>{checked.errors.length.toLocaleString("en-IN")} with a problem</span>.
          </p>
        )}
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
      </div>
      <Problems title="Problems found by the check" rows={checked?.errors ?? []} />
      <Problems title="Not brought across" rows={failures.map((f) => ({ line: f.line, label: f.key, error: f.error }))} />
    </Section>
  );
}

function Problems({ title, rows }: { title: string; rows: { line: number; label: string; error: string }[] }) {
  if (rows.length === 0) return null;
  return (
    <details className="mt-3 rounded-lg border border-danger/30 px-3 py-2" open={rows.length <= 5}>
      <summary className="cursor-pointer text-xs font-medium text-danger">
        {title} ({rows.length.toLocaleString("en-IN")}) — fix them in the file and upload it again; what already came is passed over
      </summary>
      <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto text-xs">
        {rows.slice(0, 500).map((r, i) => (
          <li key={`${r.line}-${i}`} className="flex gap-2">
            <span className="shrink-0 text-muted">Row {r.line}</span>
            <span className="shrink-0 font-medium text-text">{r.label}</span>
            <span className="text-text">{r.error}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function BalancesCard({ number, months }: { number: number; months: MonthCheck[] }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement | null>(null);
  const [month, setMonth] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ line: number; error: string }[]>([]);
  const [pending, start] = useTransition();
  const uploadedAll = months.every((x) => x.uploaded);
  return (
    <Section
      number={number}
      title="The old system's month-end trial balances"
      done={uploadedAll}
      actions={
        <Button type="button" size="sm" variant="ghost" onClick={() => downloadTemplate("balances", setError)}>
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          Template
        </Button>
      }
    >
      <p className="text-sm text-muted">
        The trial balance at the end of every month from {monthLabel(months[0]?.month ?? "")} to {monthLabel(months[months.length - 1]?.month ?? "")}: one file with a Month
        column, or one file a month with the month chosen here. Uploading a month again replaces it.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <Label htmlFor="mig-tb-month">Month</Label>
          <Select id="mig-tb-month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-56">
            <option value="">From a Month column</option>
            {months.map((x) => (
              <option key={x.month} value={x.month}>
                {monthLabel(x.month)}
              </option>
            ))}
          </Select>
        </div>
        <input
          ref={input}
          type="file"
          accept=".csv,.xlsx"
          className="sr-only"
          aria-label="Upload a trial balance"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            start(async () => {
              setError(null);
              setFailed([]);
              const r = await uploadMigrationBalances({ ...(await readFile(f)), month: month || null });
              if (!r.ok) return setError(r.error);
              if (r.data.failed.length) return setFailed(r.data.failed);
              router.refresh();
            });
          }}
        />
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
          Upload trial balance
        </Button>
      </div>
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} className="mt-2" />
      <Problems title="Nothing was kept — these rows can't be read" rows={failed.map((f) => ({ line: f.line, label: "", error: f.error }))} />
      <ul className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4" aria-label="Months">
        {months.map((x) => (
          <li key={x.month} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <span className="whitespace-nowrap text-text">{monthLabel(x.month)}</span>
            {!x.uploaded ? (
              <Badge>Not uploaded</Badge>
            ) : x.agrees ? (
              <Badge tone="green">Agrees</Badge>
            ) : (
              <Badge tone="red">{x.differences.length} off</Badge>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function DifferencesCard({ number, months, adjustments, accounts }: { number: number; months: MonthCheck[]; adjustments: Adjustment[]; accounts: Account[] }) {
  const off = months.filter((x) => x.uploaded && !x.agrees);
  return (
    <Section number={number} title="Differences" done={months.length > 0 && months.every((x) => x.agrees)}>
      {off.length === 0 ? (
        <p className="text-sm text-muted">
          {months.some((x) => x.uploaded) ? "Every month uploaded agrees with the old system, account by account." : "Upload the trial balances to see how each month compares."}
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Where Deskzo&apos;s books and the old system&apos;s differ. Usually something a file didn&apos;t carry — fix the file and bring it again. Last year&apos;s profit
            sitting in Opening Balance Equity here and in Retained Earnings there is one adjustment between the two, in the year&apos;s first month.
          </p>
          {off.map((x) => (
            <details key={x.month} className="rounded-lg border border-line px-3 py-2" open={off.length === 1}>
              <summary className="cursor-pointer text-sm font-medium text-text">
                {monthLabel(x.month)} — {x.differences.length} account{x.differences.length === 1 ? "" : "s"} off
              </summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[440px] text-left text-xs">
                  <thead>
                    <tr className="text-muted">
                      <th className="py-1 pr-3 font-medium">Account</th>
                      <th className="py-1 pr-3 text-right font-medium">Deskzo</th>
                      <th className="py-1 pr-3 text-right font-medium">Old system</th>
                      <th className="py-1 text-right font-medium">Difference</th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.differences.map((d) => (
                      <tr key={d.accountId} className="border-t border-line">
                        <td className="py-1 pr-3 text-text">
                          {d.code} {d.name}
                        </td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-text">{drCr(d.deskzo)}</td>
                        <td className="py-1 pr-3 text-right tabular-nums whitespace-nowrap text-text">{drCr(d.old)}</td>
                        <td className="py-1 text-right tabular-nums whitespace-nowrap text-danger">{drCr(d.difference)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[11px] text-muted">The difference is what Deskzo has more of: a debit (Dr) or a credit (Cr).</p>
              </div>
            </details>
          ))}
        </div>
      )}
      <AdjustmentForm months={months.map((x) => x.month)} accounts={accounts} />
      {adjustments.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs font-medium text-muted">Adjustments made</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {adjustments.map((a) => (
              <li key={a.id} className="text-text">
                {a.entryNumber} · {dayLabel(a.date)} · {money(a.amount)} from {a.credit?.name ?? "?"} to {a.debit?.name ?? "?"} — {a.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function AdjustmentForm({ months, accounts }: { months: string[]; accounts: Account[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ month: months[0] ?? "", debitAccountId: "", creditAccountId: "", amount: "", reason: "" });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <div className="mt-4">
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add an adjustment…
      </Button>
      <Dialog open={open} onClose={() => !pending && setOpen(false)} title="Adjustment">
        <div className="space-y-3">
          <p className="text-sm text-muted">One entry on the month&apos;s last day, between two accounts, with the reason kept beside it. Undo takes it back with the rest.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="adj-month">Month</Label>
              <Select id="adj-month" value={form.month} onChange={(e) => set("month", e.target.value)}>
                {months.map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-amount">Amount (₹)</Label>
              <Input id="adj-amount" inputMode="decimal" value={form.amount} onChange={(e) => set("amount", e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-debit">Debit</Label>
              <Select id="adj-debit" value={form.debitAccountId} onChange={(e) => set("debitAccountId", e.target.value)}>
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="adj-credit">Credit</Label>
              <Select id="adj-credit" value={form.creditAccountId} onChange={(e) => set("creditAccountId", e.target.value)}>
                <option value="">Choose an account</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-reason">Why</Label>
            <Input id="adj-reason" value={form.reason} onChange={(e) => set("reason", e.target.value)} maxLength={300} />
          </div>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await addMigrationAdjustment(form);
                  if (!r.ok) return setError(r.error);
                  setOpen(false);
                  setForm((f) => ({ ...f, amount: "", reason: "" }));
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Post adjustment
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function FinishCard({ number, migration, agreed, canFinish }: { number: number; migration: MigrationRow; agreed: boolean; canFinish: boolean }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Section number={number} title="Finish" done={false}>
      {!agreed ? (
        <p className="flex items-start gap-1.5 text-sm text-muted">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          Finish is offered once every month&apos;s trial balance is uploaded and agrees.
        </p>
      ) : !canFinish ? (
        <p className="text-sm text-muted">Every month agrees. Finishing locks the months, so it needs the right to close the books — ask an admin to finish it.</p>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-text">
            Every month agrees with the old system. Finishing locks the books to the day before {dayLabel(migration.switchDate)}: nothing more can be posted into the year
            that came across, and it can&apos;t be undone.
          </p>
          <Button type="button" onClick={() => setConfirming(true)}>
            Finish and lock the months
          </Button>
        </div>
      )}
      <Dialog open={confirming} onClose={() => !pending && setConfirming(false)} title="Finish the migration">
        <div className="space-y-4">
          <p className="text-sm text-text">The books lock to the day before {dayLabel(migration.switchDate)}, and the files kept for the import are deleted. Undo is no longer offered.</p>
          <ActionNoticeRegion notice={error ? { tone: "error", message: error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={pending}>
              Not yet
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await finishMigrationAction();
                  if (!r.ok) return setError(r.error);
                  setConfirming(false);
                  router.refresh();
                })
              }
            >
              {pending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />}
              Finish
            </Button>
          </div>
        </div>
      </Dialog>
    </Section>
  );
}
