"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { listAudiences, listTemplates } from "@/actions/marketing";
import { previewAudience, saveCampaign } from "@/actions/marketing";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { formatMinute } from "@/lib/marketing/schedule";
import { TOPICS } from "@/lib/marketing/topics";

type Audience = Awaited<ReturnType<typeof listAudiences>>[number];
type Template = Awaited<ReturnType<typeof listTemplates>>[number];

const HOURS = Array.from({ length: 24 }, (_, h) => h * 60);

/**
 * Putting an audience and a template together.
 *
 * Nothing is sent from here. Saving makes a draft; the list then offers Schedule, which freezes the
 * recipients and hands them to the scheduler. Two steps on purpose — the count and its breakdown
 * belong between deciding to send and actually sending.
 */
export function CampaignEditor({
  audiences,
  templates,
}: {
  audiences: Audience[];
  templates: Template[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ sendable: number; suppressed: number } | null>(null);

  const [form, setForm] = useState({
    name: "",
    audienceId: "",
    templateId: "",
    scheduledFor: "",
    windowStart: "",
    windowEnd: "",
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setCount(null);
    setForm((f) => ({ ...f, [k]: e.target.value }));
  };

  const audience = audiences.find((a) => a.id === form.audienceId);
  const template = templates.find((t) => t.id === form.templateId);
  const ready = form.name.trim() && form.audienceId && form.templateId;

  const missingPieces =
    audiences.length === 0 && templates.length === 0
      ? "an audience and a template"
      : audiences.length === 0
        ? "an audience"
        : templates.length === 0
          ? "a template"
          : null;

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        New campaign
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="New campaign">
        {missingPieces ? (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              You need {missingPieces} first. An audience is who it goes to; a template is what they receive.
            </p>
            <div className="flex gap-2">
              {audiences.length === 0 && (
                <Button variant="secondary" onClick={() => router.push("/marketing/audiences")}>
                  Build an audience
                </Button>
              )}
              {templates.length === 0 && (
                <Button variant="secondary" onClick={() => router.push("/marketing/templates")}>
                  Write a template
                </Button>
              )}
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cname">Name</Label>
              <Input
                id="cname"
                value={form.name}
                onChange={set("name")}
                placeholder="August renewals — 60 day nudge"
              />
              <p className="text-xs text-subtle">For you. The customer never sees it.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="caud">Who it goes to</Label>
              <Select id="caud" value={form.audienceId} onChange={set("audienceId")}>
                <option value="">Choose an audience…</option>
                {audiences.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ctpl">What they get</Label>
              <Select id="ctpl" value={form.templateId} onChange={set("templateId")}>
                <option value="">Choose a template…</option>
                {templates
                  .filter((t) => t.active)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} ({t.channel === "WHATSAPP" ? "WhatsApp" : "Email"})
                    </option>
                  ))}
              </Select>
              {template && (
                <p className="text-xs text-subtle">
                  Only contacts opted in to{" "}
                  <span className="text-text">{TOPICS.find((x) => x.key === template.topic)?.label}</span> will
                  receive it.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cwhen">Not before</Label>
              <Input id="cwhen" type="datetime-local" value={form.scheduledFor} onChange={set("scheduledFor")} />
              <p className="text-xs text-subtle">
                Leave blank to go as soon as it is scheduled. Quiet hours, weekends and company holidays still apply
                on top of this — a campaign set for 2am on a Sunday waits until Monday morning.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cws">Only between</Label>
                <Select id="cws" value={form.windowStart} onChange={set("windowStart")}>
                  <option value="">Any time it&apos;s allowed</option>
                  {HOURS.map((m) => (
                    <option key={m} value={m}>
                      {formatMinute(m)}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cwe">and</Label>
                <Select id="cwe" value={form.windowEnd} onChange={set("windowEnd")} disabled={!form.windowStart}>
                  <option value="">—</option>
                  {HOURS.map((m) => (
                    <option key={m} value={m}>
                      {formatMinute(m)}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {count && (
              <Card className="bg-surface-sunken px-3 py-2.5 text-sm">
                <span className="font-semibold tabular-nums text-text">{count.sendable}</span> would receive it;{" "}
                <span className="tabular-nums text-muted">{count.suppressed}</span> would not.
                {count.sendable === 0 && (
                  <span className="mt-1 block text-xs text-warning">
                    Nobody at all — check the audience&apos;s breakdown before going further.
                  </span>
                )}
              </Card>
            )}

            {error && <p className="text-sm text-danger">{error}</p>}

            <p className="text-xs text-subtle">
              Saving makes a draft. Nothing goes out until you press Schedule on it, and above the size set in
              Settings somebody else has to approve it first.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                disabled={pending || !ready}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await saveCampaign({
                      name: form.name,
                      audienceId: form.audienceId,
                      templateId: form.templateId,
                      channel: template?.channel ?? "EMAIL",
                      scheduledFor: form.scheduledFor || undefined,
                      windowStartMinute: form.windowStart ? Number(form.windowStart) : null,
                      windowEndMinute: form.windowEnd ? Number(form.windowEnd) : null,
                    });
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setOpen(false);
                    setForm({ name: "", audienceId: "", templateId: "", scheduledFor: "", windowStart: "", windowEnd: "" });
                    router.refresh();
                  });
                }}
              >
                {pending ? "Saving…" : "Save as draft"}
              </Button>
              <Button
                variant="secondary"
                disabled={pending || !audience}
                onClick={() => {
                  if (!audience) return;
                  startTransition(async () => {
                    const result = await previewAudience({
                      companyFilters: audience.companyFilters,
                      contactFilters: audience.contactFilters,
                      topic: template?.topic,
                      channel: template?.channel,
                    });
                    if (result) setCount({ sendable: result.sendable, suppressed: result.suppressed });
                  });
                }}
              >
                Who&apos;d get this?
              </Button>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
