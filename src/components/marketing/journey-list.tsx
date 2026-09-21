"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckSquare, Mail, Pause, Play, Route, Search } from "lucide-react";
import type { listAudiences, listJourneys, listTemplates, previewTrigger } from "@/actions/marketing";
import { JourneyEditor } from "@/components/marketing/journey-editor";
import { previewTrigger as runPreview, setJourneyStatus } from "@/actions/marketing";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { exitLabels, parseExitConditions } from "@/lib/marketing/journey";
import { triggerByKey } from "@/lib/marketing/triggers";

type Journey = Awaited<ReturnType<typeof listJourneys>>[number];
type Preview = NonNullable<Awaited<ReturnType<typeof previewTrigger>>>;
type Audience = Awaited<ReturnType<typeof listAudiences>>[number];
type Template = Awaited<ReturnType<typeof listTemplates>>[number];

const TONE: Record<string, "default" | "green" | "amber"> = {
  DRAFT: "default",
  ACTIVE: "green",
  PAUSED: "amber",
  ARCHIVED: "default",
};

export function JourneyList({
  journeys,
  canSend,
  canManage,
  audiences,
  templates,
}: {
  journeys: Journey[];
  canSend: boolean;
  canManage: boolean;
  audiences: Audience[];
  templates: Template[];
}) {
  if (journeys.length === 0) {
    return (
      <Card className="px-4 py-12 text-center">
        <Route className="mx-auto mb-2 h-5 w-5 text-subtle" />
        <p className="text-sm text-subtle">
          No journeys yet. A journey watches for something happening — a renewal coming up, a warranty running out —
          and then does something about it, which can be a task for one of ours rather than an email.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {journeys.map((j) => (
        <JourneyRow key={j.id} journey={j} canSend={canSend} canManage={canManage} audiences={audiences} templates={templates} />
      ))}
    </div>
  );
}

function JourneyRow({
  journey,
  canSend,
  canManage,
  audiences,
  templates,
}: {
  journey: Journey;
  canSend: boolean;
  canManage: boolean;
  audiences: Audience[];
  templates: Template[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const trigger = triggerByKey[journey.trigger];
  const exits = parseExitConditions(journey.exitOn);
  const config = (journey.triggerConfig ?? {}) as Record<string, unknown>;
  const days = typeof config.days === "number" ? config.days : trigger?.defaultDays;

  return (
    <Card className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text">{journey.name}</span>
            <Badge tone={TONE[journey.status]}>{journey.status.toLowerCase()}</Badge>
            {journey._count.enrolments > 0 && <Badge tone="blue">{journey._count.enrolments} enrolled</Badge>}
          </div>

          <p className="text-xs text-muted">
            {trigger?.label ?? journey.trigger}
            {days !== undefined && trigger?.daysLabel && ` · ${trigger.daysLabel.toLowerCase()}: ${days}`}
            {journey.audience && ` · narrowed to ${journey.audience.name}`}
          </p>

          {/* What it enrols, and what it deliberately leaves out — the part people argue about. */}
          {trigger && (
            <p className="text-[11px] text-subtle">
              {trigger.enrols}
              {trigger.excludes && ` Not: ${trigger.excludes}`}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {journey.steps.map((s) => (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted"
              >
                {s.channel === "TASK" || s.channel === "NOTIFICATION" ? (
                  <CheckSquare className="h-3 w-3" />
                ) : (
                  <Mail className="h-3 w-3" />
                )}
                {s.delayDays > 0 ? `+${s.delayDays}d · ` : ""}
                {s.template?.name ?? s.taskTitle ?? "Step"}
              </span>
            ))}
          </div>

          {exits.length > 0 && (
            <p className="text-[11px] text-subtle">
              Stops if: {exits.map((e) => exitLabels[e].toLowerCase()).join(", ")}
              {journey.reEnrolAfterDays
                ? ` · may start again after ${journey.reEnrolAfterDays} days`
                : " · runs once per subject"}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await runPreview({
                  trigger: journey.trigger,
                  triggerConfig: config,
                  audienceId: journey.audienceId,
                });
                if (!result) {
                  setError("Couldn't work that out.");
                  return;
                }
                setPreview(result);
              });
            }}
          >
            <Search className="mr-1.5 h-3 w-3" />
            {pending ? "Counting…" : "Who'd it catch?"}
          </Button>
          {canManage && <JourneyEditor journey={journey} audiences={audiences} templates={templates} />}
          {canSend && (
            <Button
              size="sm"
              variant={journey.status === "ACTIVE" ? "ghost" : "primary"}
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await setJourneyStatus(journey.id, journey.status === "ACTIVE" ? "PAUSED" : "ACTIVE");
                  if (!result.ok) setError(result.error);
                  router.refresh();
                });
              }}
            >
              {journey.status === "ACTIVE" ? (
                <>
                  <Pause className="mr-1.5 h-3 w-3" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="mr-1.5 h-3 w-3" />
                  Start
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-danger">{error}</p>}

      {preview && (
        <div className="mt-3 rounded-lg bg-surface-sunken px-3 py-2">
          <p className="text-xs text-text">
            <span className="font-semibold tabular-nums">{preview.count}</span> would be enrolled today.
          </p>
          {preview.sample.length > 0 && <p className="mt-0.5 text-xs text-muted">{preview.sample.join(" · ")}</p>}
          {preview.count === 0 && (
            <p className="mt-0.5 text-xs text-subtle">
              Nothing matches right now, which may be exactly right — a renewal trigger with nothing due is a quiet
              month, not a broken journey.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
