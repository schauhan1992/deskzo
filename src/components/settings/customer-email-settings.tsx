"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Ban, Hand, Info, Send, Workflow, Zap } from "lucide-react";
import { setCustomerEmailSwitch } from "@/actions/customer-emails";
import { setAutomationWorkflowStatus } from "@/actions/automate";
import type { CustomerEmailOverview, CustomerEmailRow, CustomerWorkflow, StopRule, WorkflowEmailKind } from "@/lib/customer-emails";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

const STOPS: Record<StopRule, string> = {
  hard: "Goes unless the address bounced, reported your mail as spam, or is a reseller's customer.",
  choices: "Also stops for a customer who opted out: unsubscribed from everything, suppressed here, or unticked its topic.",
  marketing: "Only to people who opted in; stops at an unsubscribe, within quiet hours and the weekly cap.",
};

const KINDS: Record<WorkflowEmailKind, string> = { email: "an email", document: "a document", meeting: "a meeting invitation" };

/**
 * Settings › Customer emails (owner, 18 Oct 2026) — src/lib/customer-emails.ts. Every email customers
 * get from here; the ones that go on their own carry their switch, saved as it's flipped.
 */
export function CustomerEmailSettings({ overview }: { overview: CustomerEmailOverview }) {
  const [, startTransition] = useTransition();
  const [rows, setRows] = useState(overview.rows);
  const [workflows, setWorkflows] = useState(overview.workflows);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flip = (row: CustomerEmailRow, on: boolean) => {
    if (!row.toggle) return;
    const kind = row.toggle.kind;
    setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, toggle: { kind, on } } : r)));
    setBusy(row.key);
    setError(null);
    startTransition(async () => {
      const result = await setCustomerEmailSwitch({ kind, on });
      setBusy(null);
      if (!result.ok) {
        setRows((prev) => prev.map((r) => (r.key === row.key ? row : r)));
        setError(result.error);
      }
    });
  };

  const flipWorkflow = (workflow: CustomerWorkflow, on: boolean) => {
    const status = on ? "ACTIVE" : "PAUSED";
    setWorkflows((prev) => prev?.map((w) => (w.id === workflow.id ? { ...w, status } : w)) ?? null);
    setBusy(workflow.id);
    setError(null);
    startTransition(async () => {
      const result = await setAutomationWorkflowStatus(workflow.id, status);
      setBusy(null);
      if (!result.ok) {
        setWorkflows((prev) => prev?.map((w) => (w.id === workflow.id ? workflow : w)) ?? null);
        setError(result.error);
      }
    });
  };

  const automatic = rows.filter((r) => r.automatic);
  const byHand = rows.filter((r) => !r.automatic);

  return (
    <div className="space-y-4">
      {error && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

      <Card className="bg-surface-sunken">
        <CardContent className="space-y-2 py-3 text-sm text-muted">
          <div className="flex items-start gap-2">
            <Ban className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Nothing goes to an address that bounced, one that reported your mail as spam, or a reseller&apos;s customer — they hear from their
              reseller.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Customers choose for themselves through the <span className="font-medium text-text">Manage what we send you</span> link on
              reminders and marketing: reminders stop when they untick them or unsubscribe from everything. What&apos;s part of business
              they have with you — an invoice, an order confirmation, a ticket reply, a meeting invitation — still goes.
            </span>
          </div>
          <div className="flex items-start gap-2">
            <Send className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {overview.companyServer ? (
                <>
                  Your mail server sends as <span className="font-medium text-text">{overview.companyServer}</span>.
                </>
              ) : (
                <>Your company has no mail server set up, so some of these go through Deskzo&apos;s mail and some aren&apos;t sent at all.</>
              )}{" "}
              <Link href="/settings/messaging" className="text-brand hover:underline">
                Mail &amp; messaging
              </Link>
            </span>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <Zap className="h-4 w-4" />
            Sent on their own
          </div>
          <div className="mt-0.5 text-xs text-muted">Something happens, and the email goes. Switch off any you don&apos;t want.</div>
        </CardHeader>
        <CardContent className="p-0">
          {automatic.map((row) => (
            <EmailRow key={row.key} row={row} busy={busy !== null} onFlip={(on) => flip(row, on)} />
          ))}
          {workflows !== null && (
            <div className="border-t border-line px-5 py-3">
              <div className="flex items-center gap-2 text-sm text-text">
                <Workflow className="h-4 w-4 text-muted" />
                Workflows that email customers
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Each goes as its workflow says. {STOPS.choices} An invoice or a meeting invitation a workflow sends goes as one sent by hand.
              </p>
              {workflows.length === 0 ? (
                <p className="mt-2 text-xs text-muted">None of your workflows emails customers.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line rounded-base border border-line">
                  {workflows.map((w) => (
                    <li key={w.id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <Link href={`/automate/workflows/${w.ref}`} className="text-sm text-brand hover:underline">
                          {w.name}
                        </Link>
                        <div className="text-xs text-muted">
                          {[w.when, `sends ${w.kinds.map((k) => KINDS[k]).join(", ")}`, w.owner ? `owned by ${w.owner}` : null].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                      <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
                        {w.status === "ACTIVE" ? "On" : "Paused"}
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={w.status === "ACTIVE"}
                          disabled={busy !== null}
                          aria-label={`${w.name} — on`}
                          onChange={(e) => flipWorkflow(w, e.target.checked)}
                        />
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2 text-sm font-medium text-text">
            <Hand className="h-4 w-4" />
            Sent by a person
          </div>
          <div className="mt-0.5 text-xs text-muted">Somebody here presses send each time, so there&apos;s nothing to switch off.</div>
        </CardHeader>
        <CardContent className="p-0">
          {byHand.map((row) => (
            <EmailRow key={row.key} row={row} busy={busy !== null} onFlip={() => {}} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function EmailRow({ row, busy, onFlip }: { row: CustomerEmailRow; busy: boolean; onFlip: (on: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3 last:border-0">
      <div className="min-w-0 space-y-0.5">
        <div className="text-sm text-text">{row.label}</div>
        <div className="text-xs text-muted">To: {row.to}</div>
        <div className="text-xs text-muted">From: {row.from}</div>
        <div className="text-xs text-muted">{STOPS[row.stops]}</div>
        {row.note && <div className="text-xs text-muted">{row.note}</div>}
        {row.manage && (
          <Link href={row.manage.href} className="text-xs text-brand hover:underline">
            {row.manage.label}
          </Link>
        )}
      </div>
      {row.toggle && (
        <label className="flex shrink-0 items-center gap-2 text-xs text-muted">
          {row.toggle.on ? "On" : "Off"}
          <input type="checkbox" className="h-4 w-4" checked={row.toggle.on} disabled={busy} aria-label={`${row.label} — on`} onChange={(e) => onFlip(e.target.checked)} />
        </label>
      )}
    </div>
  );
}
