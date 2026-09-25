"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { resetAllDataNow } from "@/actions/data-reset";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * TEMPORARY — "reset all data", for the testing phase. See src/lib/data-reset.ts.
 */
export type DataResetOverview = {
  counts: { users: number; companies: number; contacts: number; leads: number; orders: number; documents: number; payments: number; tickets: number };
  tables: number;
  kept: string[];
  you: string;
  phrase: string;
};

export function DataResetPanel({ overview }: { overview: DataResetOverview }) {
  const [confirm, setConfirm] = useState("");
  const [backupFirst, setBackupFirst] = useState(true);
  const [result, setResult] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const c = overview.counts;
  const ready = confirm.trim().toUpperCase() === overview.phrase;

  function reset() {
    setResult(null);
    startTransition(async () => {
      const r = await resetAllDataNow({ confirm, backupFirst });
      if (!r.ok) {
        setResult({ tone: "error", text: r.error });
        return;
      }
      setResult({
        tone: "success",
        text: `Done — ${r.data.tablesEmptied} tables emptied and ${r.data.usersRemoved} users removed.${r.data.backup ? ` The backup taken first is ${r.data.backup}, listed above.` : ""}`,
      });
      setConfirm("");
      // Every figure on this screen is out of date now, the backup log included.
      router.refresh();
    });
  }

  return (
    <Card className="border-danger/40">
      <CardHeader className="flex items-center gap-2 text-sm font-semibold text-danger">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        Reset all data — for testing only
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-text">
          Empties the whole database back to a fresh install. Right now it holds {c.users} users, {c.companies} companies, {c.contacts} contacts,{" "}
          {c.leads} leads, {c.orders} orders, {c.documents} quotes and invoices, {c.payments} payments and {c.tickets} tickets — all of it goes,
          across {overview.tables} tables, with every setting: organisation details, branding, modules, permissions, numbering and email providers.
        </p>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted">What stays</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
            {overview.kept.map((k) => (
              <li key={k}>{k.replace(/^you\b/, `you (${overview.you})`)}</li>
            ))}
            <li>the starter customer categories, as a fresh install has them</li>
          </ul>
        </div>
        <label className="flex items-start gap-2 text-text">
          <input type="checkbox" className="mt-1" checked={backupFirst} onChange={(e) => setBackupFirst(e.target.checked)} />
          <span>
            Take a full backup first <span className="text-muted">— the reset can then be undone by restoring it from this page.</span>
          </span>
        </label>
        <div className="max-w-sm space-y-1">
          <Label htmlFor="reset-confirm">Type {overview.phrase} to confirm</Label>
          <Input id="reset-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" disabled={pending} />
        </div>
        {result && <ActionNotice tone={result.tone}>{result.text}</ActionNotice>}
        <Button variant="danger" disabled={!ready || pending} onClick={reset}>
          {pending ? (backupFirst ? "Backing up, then resetting…" : "Resetting…") : "Reset all data"}
        </Button>
        <p className="text-xs text-subtle">Only the super admin sees this, and only while ENABLE_DATA_RESET=true is set. Remove it before production.</p>
      </CardContent>
    </Card>
  );
}
