"use client";

import { useState } from "react";
import { Check, CircleAlert, ScrollText, Stethoscope, TriangleAlert, Wrench } from "lucide-react";
import { consoleProbeWorkspaceDb, consoleReapplyRoleLimits } from "@/actions/platform/console-workspace";
import { ActionButton } from "@/components/console/kit/action-button";
import { CopyButton } from "@/components/console/kit/copy-field";
import { InsetBlock } from "@/components/console/kit/panel";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNotice } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { SidePane } from "@/components/ui/side-pane";
import { cn } from "@/lib/utils";

/**
 * Workspace 360 › Operations' client pieces: a migration's output in a side pane, the on-demand
 * database check (never run when the page loads — it asks the database server), and putting the
 * database role's limits back.
 */

/** A migration run's output (already redacted by the loader), read in a side pane without leaving the list. */
export function OutputPaneButton({ title, output }: { title: string; output: string | null }) {
  const [open, setOpen] = useState(false);
  if (!output || !output.trim()) return <span className="text-xs text-muted">No output</span>;
  const lines = output.trimEnd().split("\n").length;
  return (
    <>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(true)} aria-haspopup="dialog">
        <ScrollText aria-hidden="true" className="h-3.5 w-3.5" />
        View output
      </Button>
      <SidePane open={open} onClose={() => setOpen(false)} title={title}>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted">{`${lines.toLocaleString("en-IN")} ${lines === 1 ? "line" : "lines"} · secrets masked`}</p>
            <CopyButton value={output} label="Copy the output" />
          </div>
          <pre className="max-w-full overflow-x-auto rounded-lg border border-line bg-surface-sunken p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-text">
            {output}
          </pre>
        </div>
      </SidePane>
    </>
  );
}

type Probe = { exists: boolean; limits: { settings: string[]; connections: number } | null; expected: { settings: string[]; connections: number } };

/** "statement_timeout=30000" → ["statement_timeout", "30000"]. */
const settingParts = (s: string): [string, string] => {
  const at = s.indexOf("=");
  return at < 0 ? [s, ""] : [s.slice(0, at), s.slice(at + 1)];
};

/**
 * Whether its database is on the server, and whether its role's limits are the ones the platform
 * sets — asked only when somebody presses the button. Changes nothing.
 */
export function ProbeDatabase({ tenantId }: { tenantId: string }) {
  const [result, setResult] = useState<Probe | null>(null);
  const { pending, error, run } = useConsoleAction<Probe>();

  function check() {
    setResult(null);
    run(() => consoleProbeWorkspaceDb(tenantId), { refresh: false, success: "", onDone: setResult });
  }

  const actual = new Map((result?.limits?.settings ?? []).map(settingParts));
  const rows = (result?.expected.settings ?? []).map(settingParts).map(([name, want]) => ({ name, want, have: actual.get(name) ?? null }));
  const connectionsOk = result?.limits ? result.limits.connections === result.expected.connections : false;
  const allOk = !!result && result.exists && !!result.limits && connectionsOk && rows.every((r) => r.have === r.want);

  return (
    <div className="space-y-3">
      <Button type="button" size="sm" variant="secondary" onClick={check} aria-disabled={pending || undefined} aria-busy={pending || undefined} className={cn(pending && "cursor-wait opacity-70")}>
        <Stethoscope aria-hidden="true" className={cn("h-4 w-4", pending && "animate-pulse")} />
        {pending ? "Checking…" : result ? "Check again" : "Check database"}
      </Button>
      <div aria-live="polite">
        {error && <ActionNotice tone="error">{error}</ActionNotice>}
        {result && (
          <InsetBlock className="space-y-2.5">
            <p className={cn("flex items-center gap-1.5 text-sm font-medium", allOk ? "text-success" : "text-warning")}>
              {allOk ? <Check aria-hidden="true" className="h-4 w-4" /> : <TriangleAlert aria-hidden="true" className="h-4 w-4" />}
              {allOk ? "The database is there, with the limits the platform sets." : "Something is not as the platform set it."}
            </p>
            <ul className="space-y-1 text-xs">
              <ProbeLine ok={result.exists} label="Database" value={result.exists ? "exists on the server" : "not found on the server"} />
              {result.limits ? (
                <>
                  <ProbeLine
                    ok={connectionsOk}
                    label="Connection limit"
                    value={connectionsOk ? String(result.limits.connections) : `${result.limits.connections} — expected ${result.expected.connections}`}
                  />
                  {rows.map((r) => (
                    <ProbeLine key={r.name} ok={r.have === r.want} label={r.name} value={r.have === r.want ? r.want : `${r.have ?? "not set"} — expected ${r.want}`} mono />
                  ))}
                </>
              ) : (
                <ProbeLine ok={false} label="Role" value="not found — its limits could not be read" />
              )}
            </ul>
          </InsetBlock>
        )}
      </div>
    </div>
  );
}

function ProbeLine({ ok, label, value, mono }: { ok: boolean; label: string; value: string; mono?: boolean }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? <Check aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-success" /> : <CircleAlert aria-hidden="true" className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />}
      <span className="sr-only">{ok ? "As expected: " : "Differs: "}</span>
      <span className={cn("min-w-0 text-muted", mono && "font-mono")}>{label}</span>
      <span className="ml-auto min-w-0 text-right break-words text-text tabular-nums">{value}</span>
    </li>
  );
}

/** Its database role's timeouts and connection limit put back as the provisioner sets them (T1). */
export function ReapplyLimitsButton({ tenantId }: { tenantId: string }) {
  return (
    <ActionButton
      action={() => consoleReapplyRoleLimits(tenantId)}
      label="Re-apply role limits"
      icon={<Wrench aria-hidden="true" className="h-4 w-4" />}
      confirm={{
        title: "Re-apply role limits",
        body: "Sets its database role's statement, lock and idle-in-transaction timeouts and its connection limit back to what the platform gives every workspace. Sessions already open keep the old settings until they reconnect.",
        confirmLabel: "Re-apply limits",
      }}
      success="Role limits re-applied."
    />
  );
}
