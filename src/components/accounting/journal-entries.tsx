"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Undo2 } from "lucide-react";
import type { JournalSource } from "@prisma/client";
import { reverseJournalEntry } from "@/actions/ledger";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import { Amount } from "@/components/accounting/report-chrome";

const SOURCE_LABEL: Record<JournalSource, string> = {
  INVOICE: "Invoice",
  CREDIT_NOTE: "Credit note",
  BILL: "Bill",
  PAYMENT: "Payment",
  EXPENSE: "Expense",
  MANUAL: "Manual",
  OPENING: "Opening",
  PAYROLL: "Payroll",
  DEPRECIATION: "Depreciation",
  CLOSING: "Year end",
  FX: "Exchange",
};

const SOURCE_TONE: Record<JournalSource, "default" | "green" | "blue" | "red" | "amber"> = {
  INVOICE: "green",
  CREDIT_NOTE: "amber",
  BILL: "blue",
  PAYMENT: "blue",
  EXPENSE: "default",
  MANUAL: "default",
  OPENING: "default",
  PAYROLL: "blue",
  DEPRECIATION: "default",
  CLOSING: "red",
  FX: "amber",
};

type Entry = {
  id: string;
  entryNumber: string;
  date: Date | string;
  narration: string;
  source: JournalSource;
  documentId: string | null;
  reversesId: string | null;
  reversedBy: { id: string; entryNumber: string } | null;
  company: { id: string; name: string } | null;
  createdBy: { name: string };
  amount: number;
  lines: {
    id: string;
    debit: number;
    credit: number;
    narration: string | null;
    account: { id: string; code: string; name: string };
    company: { id: string; name: string } | null;
  }[];
};

/**
 * The journal: every entry with its lines laid out the way they'd be written by hand.
 *
 * Entries are shown expanded rather than behind a click, because a journal is read to check the
 * double entry, and a list of narrations without the accounts tells you nothing.
 */
export function JournalEntries({ entries, canReverse }: { entries: Entry[]; canReverse: boolean }) {
  return (
    <div className="space-y-3">
      {entries.map((entry) => (
        <EntryCard key={entry.id} entry={entry} canReverse={canReverse} />
      ))}
      {entries.length === 0 && (
        <Card className="px-4 py-12 text-center text-sm text-subtle">
          No entries match these filters.
        </Card>
      )}
    </div>
  );
}

function EntryCard({ entry, canReverse }: { entry: Entry; canReverse: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // A reversal can't itself be reversed — undoing an undo is just the original entry again, and
  // allowing it would let someone build a chain nobody can follow.
  const reversible = canReverse && !entry.reversedBy && !entry.reversesId;

  function reverse() {
    const reason = prompt("Why is this being reversed? (shown on the reversing entry)");
    if (reason === null) return;
    setError(null);
    startTransition(async () => {
      const result = await reverseJournalEntry({ entryId: entry.id, reason: reason.trim() || undefined });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-surface-sunken px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm font-medium text-text">{entry.entryNumber}</span>
            <Badge tone={SOURCE_TONE[entry.source]}>{SOURCE_LABEL[entry.source]}</Badge>
            <span className="text-xs text-subtle">{formatDate(entry.date)}</span>
            {entry.reversedBy && (
              <Badge tone="red">Reversed by {entry.reversedBy.entryNumber}</Badge>
            )}
            {entry.reversesId && <Badge tone="default">Reversal</Badge>}
          </div>
          <p className="mt-1 text-sm text-text">
            {entry.documentId ? (
              <Link href={`/documents/${entry.documentId}`} className="hover:underline">{entry.narration}</Link>
            ) : (
              entry.narration
            )}
          </p>
          {entry.company && (
            <Link href={`/companies/${entry.company.id}`} className="text-xs text-subtle hover:underline">
              {entry.company.name}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text"><Amount value={entry.amount} /></span>
          {reversible && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={reverse} title="Reverse this entry">
              <Undo2 className="h-3.5 w-3.5" />
              Reverse
            </Button>
          )}
        </div>
      </div>

      <table className="w-full text-sm">
        <tbody>
          {entry.lines.map((line) => (
            <tr key={line.id} className="border-b border-line last:border-0">
              <td className="px-4 py-1.5" style={{ paddingLeft: line.credit > 0 ? 40 : 16 }}>
                <Link href={`/accounting/ledger/${line.account.id}`} className="text-text hover:underline">
                  <span className="mr-2 font-mono text-xs text-subtle">{line.account.code}</span>
                  {line.account.name}
                </Link>
                {line.company && <span className="ml-2 text-xs text-subtle">· {line.company.name}</span>}
                {line.narration && <span className="ml-2 text-xs text-subtle">· {line.narration}</span>}
              </td>
              <td className="w-32 px-4 py-1.5 text-right"><Amount value={line.debit} muted={line.debit === 0} /></td>
              <td className="w-32 px-4 py-1.5 text-right"><Amount value={line.credit} muted={line.credit === 0} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {error && <p className="border-t border-line px-4 py-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
