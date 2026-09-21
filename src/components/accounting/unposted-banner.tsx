"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Loader2 } from "lucide-react";
import { postExpensesToLedger } from "@/actions/expense";
import { postPayrollRunToLedger } from "@/actions/payroll";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionNoticeRegion, type NoticeTone } from "@/components/ui/action-notice";

/**
 * The things the ledger never received, and the button that sends them.
 *
 * Posting an approved claim or a locked payroll run is allowed to fail quietly, deliberately: a
 * bookkeeping problem must never roll back somebody's approval or leave payslips unissuable. Both
 * modules say so in as many words, and both add that the posting "can be posted again" — which was
 * not true anywhere in the app. `postExpensesToLedger` and `postPayrollRunToLedger` were written,
 * gated, and called by nothing.
 *
 * So this banner told an accountant that every figure on the page was understated, linked them to a
 * screen offering no remedy, and left the only actual fix sitting in the codebase unreachable. The
 * quiet failure was defensible on the grounds that it surfaced somewhere; it surfaced as a dead end.
 */
export function UnpostedBanner({
  expenses,
  payrollRuns,
}: {
  expenses: { id: string }[];
  payrollRuns: { id: string; month: number; year: number }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: NoticeTone; message: string } | null>(null);

  if (expenses.length === 0 && payrollRuns.length === 0) return null;

  function postEverything() {
    setNotice(null);
    startTransition(async () => {
      const parts: string[] = [];
      let anyFailed = false;

      if (expenses.length > 0) {
        const result = await postExpensesToLedger(expenses.map((e) => e.id));
        if (!result.ok) {
          setNotice({ tone: "error", message: result.error });
          return;
        }
        parts.push(`${result.data.posted} claim(s) posted`);
        if (result.data.failed > 0) {
          anyFailed = true;
          parts.push(`${result.data.failed} still would not post`);
        }
      }

      /**
       * One at a time, and the first refusal stops the rest.
       *
       * These fail for a *shared* reason — the chart of accounts mid-edit, the books locked, the
       * module switched off — so grinding through twelve runs to collect twelve copies of the same
       * message helps nobody. The one message is the useful thing.
       */
      let runsPosted = 0;
      for (const run of payrollRuns) {
        const result = await postPayrollRunToLedger(run.id);
        if (!result.ok) {
          anyFailed = true;
          parts.push(
            `${String(run.month).padStart(2, "0")}/${run.year} would not post — ${result.error}`,
          );
          break;
        }
        runsPosted += 1;
      }
      if (runsPosted > 0) parts.splice(expenses.length > 0 ? 1 : 0, 0, `${runsPosted} payroll run(s) posted`);

      setNotice({ tone: anyFailed ? "error" : "success", message: parts.join(" · ") || "Nothing left to post." });
      router.refresh();
    });
  }

  return (
    <Card className="mt-4 border-warning/40 bg-warning-bg px-4 py-3 text-sm text-warning">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            Things the ledger never received
          </p>
          <p className="mt-1">
            Every figure on this page is understated until these are posted.
            {expenses.length > 0 && (
              <>
                {" "}
                <Link href="/expenses" className="underline">
                  {expenses.length} approved claim(s)
                </Link>
                .
              </>
            )}
            {payrollRuns.length > 0 && (
              <>
                {" "}
                <Link href="/people/payroll" className="underline">
                  {payrollRuns.length} payroll run(s)
                </Link>
                .
              </>
            )}
          </p>
        </div>

        <Button size="sm" variant="secondary" disabled={pending} onClick={postEverything} className="shrink-0">
          {pending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
          {pending ? "Posting…" : "Post these now"}
        </Button>
      </div>

      <ActionNoticeRegion notice={notice} className="mt-2" />
    </Card>
  );
}
