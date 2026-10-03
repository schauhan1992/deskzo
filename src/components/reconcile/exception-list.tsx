"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, RotateCcw } from "lucide-react";
import { reopenLine, resolveLine } from "@/actions/reconcile";
import { STATE_LABELS, type ReconcileState } from "@/lib/reconcile/match";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { useClock } from "@/components/time/clock-provider";

/**
 * The exceptions, and clearing one.
 *
 * Sorted by what each is worth rather than by row number, because the list is only useful if the
 * expensive lines are the ones read first — two hundred rows in file order is a file, not a report.
 */

export type ExceptionRow = {
  id: string;
  state: ReconcileState;
  source: "STATEMENT" | "OURS";
  rowNumber: number | null;
  sku: string;
  description: string | null;
  customerRef: string;
  quantity: number;
  unitCost: number;
  lineTotal: number;
  variance: number;
  note: string | null;
  matchedCompanyId: string | null;
  matchedCompanyName: string | null;
  orderLabel: string | null;
  orderQuantity: number | null;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
};

export function ExceptionList({ rows }: { rows: ExceptionRow[] }) {
  const router = useRouter();
  const clock = useClock();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const open = rows.filter((r) => !r.resolvedAt);
  const resolved = rows.filter((r) => r.resolvedAt);
  const shown = showResolved ? resolved : open;

  const clear = (id: string) => {
    if (!note.trim()) {
      setError("Say what was done about it.");
      return;
    }
    setBusy(id);
    setError(null);
    startTransition(async () => {
      const result = await resolveLine({ lineId: id, note });
      setBusy(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDrafting(null);
      setNote("");
      router.refresh();
    });
  };

  const reopen = (id: string) => {
    setBusy(id);
    startTransition(async () => {
      await reopenLine({ lineId: id });
      setBusy(null);
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-line">
        <button
          type="button"
          onClick={() => setShowResolved(false)}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${!showResolved ? "border-brand text-text" : "border-transparent text-muted hover:text-text"}`}
        >
          To look at ({open.length})
        </button>
        <button
          type="button"
          onClick={() => setShowResolved(true)}
          className={`border-b-2 px-3 py-2 text-sm font-medium ${showResolved ? "border-brand text-text" : "border-transparent text-muted hover:text-text"}`}
        >
          Cleared ({resolved.length})
        </button>
      </div>

      {error && (
        <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
      )}

      {shown.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted">
            {showResolved ? "Nothing has been cleared yet." : "Nothing to look at — every line agrees with our records."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {shown.map((row) => {
            const meta = STATE_LABELS[row.state];
            return (
              <Card key={row.id}>
                <CardContent className="space-y-2 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        <span className="font-mono text-xs text-text">{row.sku}</span>
                        {row.rowNumber && <span className="text-xs text-subtle">line {row.rowNumber}</span>}
                        {row.source === "OURS" && <span className="text-xs text-subtle">not on the statement</span>}
                      </div>
                      <div className="mt-1 text-sm font-medium text-text">
                        {row.matchedCompanyId ? (
                          <Link href={`/companies/${row.matchedCompanyId}`} className="text-brand hover:underline">
                            {row.matchedCompanyName ?? row.customerRef}
                          </Link>
                        ) : (
                          row.customerRef
                        )}
                        {row.description && <span className="ml-2 font-normal text-muted">{row.description}</span>}
                      </div>
                    </div>

                    <div className="text-right">
                      {/*
                        Signed on purpose. A negative variance is a question, not a gain, and colouring
                        it like a loss would have somebody chasing the wrong twenty lines.
                      */}
                      <div className={`text-sm font-semibold ${row.variance > 0 ? "text-danger" : "text-muted"}`}>
                        {row.variance === 0 ? "—" : formatCurrency(row.variance)}
                      </div>
                      <div className="text-xs text-muted">
                        {row.quantity} × {formatCurrency(row.unitCost)}
                      </div>
                    </div>
                  </div>

                  {row.note && <p className="text-sm text-muted">{row.note}</p>}

                  {row.orderLabel && (
                    <p className="text-xs text-subtle">
                      Our order: {row.orderLabel}
                      {row.orderQuantity !== null && ` · ${row.orderQuantity} seat${row.orderQuantity === 1 ? "" : "s"}`}
                    </p>
                  )}

                  {row.resolvedAt ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-base bg-surface-sunken px-3 py-2">
                      <p className="text-xs text-muted">
                        <span className="font-medium text-text">Cleared</span> {clock.dateTimeShort(row.resolvedAt)}
                        {row.resolvedByName ? ` by ${row.resolvedByName}` : ""} — {row.resolutionNote}
                      </p>
                      <Button variant="ghost" size="sm" onClick={() => reopen(row.id)} disabled={busy === row.id}>
                        <RotateCcw className="h-3.5 w-3.5" />
                        Reopen
                      </Button>
                    </div>
                  ) : drafting === row.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {/*
                        One card per exception, so the name says which line is being cleared — and
                        the placeholder is only an example of what to write, which disappears the
                        moment anybody starts writing it.
                      */}
                      <Input
                        aria-label={`What was done about ${row.sku}`}
                        autoFocus
                        className="min-w-48 flex-1"
                        placeholder="Raised invoice INV-1043 / distributor credited us / seats cancelled"
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") clear(row.id);
                          if (e.key === "Escape") setDrafting(null);
                        }}
                      />
                      <Button size="sm" onClick={() => clear(row.id)} disabled={busy === row.id}>
                        Clear
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDrafting(null)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setDrafting(row.id);
                        setNote("");
                        setError(null);
                      }}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Clear this
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
