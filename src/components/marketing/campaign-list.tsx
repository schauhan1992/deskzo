"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Megaphone, Send, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { dryRunCampaign, listCampaigns } from "@/actions/marketing";
import { approveCampaign, cancelCampaign, dryRunCampaign as runDryRun, scheduleCampaign } from "@/actions/marketing";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";

type DryRun = Extract<Awaited<ReturnType<typeof dryRunCampaign>>, { ok: true }>["data"];

type Campaign = Awaited<ReturnType<typeof listCampaigns>>[number];

const TONE: Record<string, "default" | "green" | "blue" | "red" | "amber"> = {
  DRAFT: "default",
  PENDING_APPROVAL: "amber",
  SCHEDULED: "blue",
  SENDING: "blue",
  SENT: "green",
  PAUSED: "amber",
  CANCELLED: "red",
};

const LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Waiting for approval",
  SCHEDULED: "Scheduled",
  SENDING: "Going out",
  SENT: "Sent",
  PAUSED: "Paused",
  CANCELLED: "Stopped",
};

export function CampaignList({
  campaigns,
  canSend,
  canApprove,
}: {
  campaigns: Campaign[];
  canSend: boolean;
  canApprove: boolean;
}) {
  if (campaigns.length === 0) {
    return (
      <Card className="px-4 py-12 text-center">
        <Megaphone className="mx-auto mb-2 h-5 w-5 text-subtle" />
        <p className="text-sm text-subtle">
          No campaigns yet. Build an audience and a template first, then a campaign puts the two together.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {campaigns.map((c) => (
        <CampaignRow key={c.id} campaign={c} canSend={canSend} canApprove={canApprove} />
      ))}
    </div>
  );
}

function CampaignRow({
  campaign,
  canSend,
  canApprove,
}: {
  campaign: Campaign;
  canSend: boolean;
  canApprove: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Nothing goes out until somebody has seen who it goes to.
   *
   * "Send now" used to be one click straight to a mailshot, and the recipient count arrived in the
   * sentence confirming it had already happened — the one number worth knowing, shown only once it
   * was too late to use. There is no recall: these are real customers, and an audience filter that
   * is one condition wrong reaches every one of them.
   */
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [checking, setChecking] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) => {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That didn't work.");
        return;
      }
      after?.();
      router.refresh();
    });
  };

  const editable = campaign.status === "DRAFT" || campaign.status === "PENDING_APPROVAL";
  const stoppable = campaign.status === "SCHEDULED" || campaign.status === "SENDING" || campaign.status === "PAUSED";

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text">{campaign.name}</span>
            <span className="font-mono text-[11px] text-subtle">{campaign.reference}</span>
            <Badge tone={TONE[campaign.status]}>{LABEL[campaign.status]}</Badge>
            {campaign.approvedBy && <Badge tone="green">Approved by {campaign.approvedBy.name}</Badge>}
          </div>
          <p className="text-xs text-muted">
            {campaign.audience.name} · {campaign.template.name}
            {campaign.scheduledFor && ` · from ${formatDate(campaign.scheduledFor)}`}
            {campaign._count.messages > 0 && ` · ${campaign._count.messages} recipient(s)`}
          </p>
          <p className="text-[11px] text-subtle">
            Built by {campaign.createdBy.name}
            {campaign.startedAt && ` · started ${formatDate(campaign.startedAt)}`}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {campaign.status === "PENDING_APPROVAL" && canApprove && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => approveCampaign(campaign.id))}>
              <ShieldCheck className="mr-1.5 h-3 w-3" />
              Approve
            </Button>
          )}
          {editable && canSend && (
            <Button
              size="sm"
              disabled={pending || checking}
              onClick={() => {
                setError(null);
                setNote(null);
                setChecking(true);
                startTransition(async () => {
                  const result = await runDryRun(campaign.id);
                  setChecking(false);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  setDryRun(result.data);
                });
              }}
            >
              {checking ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Send className="mr-1.5 h-3 w-3" />}
              {campaign.status === "PENDING_APPROVAL" ? "Send now" : "Schedule"}
            </Button>
          )}
          {stoppable && canSend && (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelCampaign(campaign.id))}>
              <X className="mr-1.5 h-3 w-3" />
              Stop
            </Button>
          )}
        </div>
      </div>

      {note && <p className="mt-2 text-xs text-success">{note}</p>}
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {dryRun && (
        <SendConfirmation
          dryRun={dryRun}
          pending={pending}
          onCancel={() => setDryRun(null)}
          onConfirm={() => {
            setDryRun(null);
            run(async () => {
              const result = await scheduleCampaign(campaign.id);
              if (result.ok) {
                setNote(
                  result.data.needsApproval
                    ? "This one is big enough to need a second pair of eyes. Somebody else has to approve it."
                    : `Queued for ${result.data.queued}. ${result.data.suppressed + result.data.blocked} won't receive it.`,
                );
              }
              return result;
            });
          }}
        />
      )}
    </Card>
  );
}

/**
 * The last thing between a filter and a customer's inbox.
 *
 * Leads with the count, because that is the number somebody is checking against what they expected.
 * The withheld are grouped by reason rather than totalled: "112 won't receive this" is a number
 * people nod at, and "80 unsubscribed, 30 no valid address, 2 reseller-managed" is one they act on.
 */
function SendConfirmation({
  dryRun,
  pending,
  onCancel,
  onConfirm,
}: {
  dryRun: DryRun;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const nobody = dryRun.willReceive === 0;

  return (
    <Dialog open onClose={onCancel} title={`Send ${dryRun.reference}?`}>
      <div className="space-y-4">
        <div>
          <div className="text-2xl font-semibold text-text">
            {dryRun.willReceive.toLocaleString("en-IN")}
            <span className="ml-1.5 text-sm font-normal text-muted">
              {dryRun.willReceive === 1 ? "person receives this" : "people receive this"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted">
            {dryRun.audienceName} &middot; &ldquo;{dryRun.subject}&rdquo;
          </p>
        </div>

        {dryRun.needsApproval && (
          <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs text-text">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            <span>
              Over {dryRun.approvalThreshold.toLocaleString("en-IN")}, so this goes for approval rather than out
              &mdash; somebody else has to release it.
            </span>
          </div>
        )}

        {nobody && (
          <div className="flex gap-2 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-text">
            <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
            <span>Nobody in this audience can be contacted. The reasons are below.</span>
          </div>
        )}

        {dryRun.sample.length > 0 && (
          <div>
            <div className="text-xs font-medium text-text">Starting with</div>
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {dryRun.sample.map((r) => (
                <li key={`${r.email}-${r.name}`}>
                  {r.name}
                  {r.company && <span className="text-subtle"> &middot; {r.company}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {dryRun.withheld > 0 && (
          <div>
            <div className="text-xs font-medium text-text">
              {dryRun.withheld.toLocaleString("en-IN")} held back
            </div>
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {dryRun.reasons.map((r) => (
                <li key={r.reason}>
                  <span className="font-medium text-text">{r.count.toLocaleString("en-IN")}</span> &mdash; {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={pending || nobody}>
            <Send className="mr-1.5 h-3 w-3" />
            {dryRun.needsApproval
              ? "Send for approval"
              : `Send to ${dryRun.willReceive.toLocaleString("en-IN")}`}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
