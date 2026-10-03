"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import type { ProjectHealth, ProjectRiskKind, ProjectRiskSeverity, ProjectRiskStatus } from "@prisma/client";
import { postUpdate, saveRisk } from "@/actions/project";
import {
  projectHealthLabels,
  riskIsOpen,
  riskKindLabels,
  riskSeverityLabels,
  riskSeverityTone,
  riskStatusLabels,
} from "@/lib/projects/status";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Input, Select, Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

type Risk = {
  id: string;
  kind: ProjectRiskKind;
  title: string;
  detail: string | null;
  severity: ProjectRiskSeverity;
  status: ProjectRiskStatus;
  mitigation: string | null;
  owner: { id: string; name: string } | null;
  raisedBy: { name: string } | null;
  raisedOn: string | Date;
};

type Update = {
  id: string;
  body: string;
  health: ProjectHealth;
  author: { name: string } | null;
  at: string | Date;
};

/**
 * What is going wrong, and what has been said about it.
 *
 * Side by side because they answer each other: an update that says "amber again this week" is only
 * useful next to the open issue that explains why.
 */
export function ProjectLog({
  projectId,
  risks,
  updates,
  users,
  currentHealth,
  canManage,
}: {
  projectId: string;
  risks: Risk[];
  updates: Update[];
  users: { id: string; name: string }[];
  currentHealth: ProjectHealth;
  canManage: boolean;
}) {
  const clock = useClock();
  const open = risks.filter((r) => riskIsOpen(r.status));
  const rest = risks.filter((r) => !riskIsOpen(r.status));

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
          Risks &amp; issues
          {open.length > 0 && <span className="text-xs font-normal text-muted">{open.length} open</span>}
        </CardHeader>
        <CardContent className="space-y-3">
          {risks.length === 0 ? (
            <p className="py-2 text-sm text-muted">Nothing raised.</p>
          ) : (
            [...open, ...rest].map((r) => (
              <div key={r.id} className="border-b border-line pb-2.5 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={riskSeverityTone[r.severity]}>{riskSeverityLabels[r.severity]}</Badge>
                  <span className="text-xs text-subtle">{riskKindLabels[r.kind]}</span>
                  <span className={`text-sm ${riskIsOpen(r.status) ? "text-text" : "text-muted line-through"}`}>
                    {r.title}
                  </span>
                </div>
                {r.detail && <p className="mt-1 text-xs text-muted">{r.detail}</p>}
                <div className="mt-1 text-xs text-subtle">
                  {riskStatusLabels[r.status]}
                  {r.owner && ` · ${r.owner.name}`}
                  {` · raised ${clock.date(r.raisedOn)}`}
                  {r.raisedBy && ` by ${r.raisedBy.name}`}
                </div>
                {/* An open risk with nothing being done about it is itself the finding. */}
                {riskIsOpen(r.status) && !r.mitigation && (
                  <p className="mt-1 text-xs text-warning">No mitigation recorded.</p>
                )}
                {r.mitigation && <p className="mt-1 text-xs text-muted">Mitigation: {r.mitigation}</p>}
              </div>
            ))
          )}
          {canManage && <AddRisk projectId={projectId} users={users} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Updates</CardHeader>
        <CardContent className="space-y-3">
          {canManage && <AddUpdate projectId={projectId} currentHealth={currentHealth} />}
          {updates.length === 0 ? (
            <p className="py-2 text-sm text-muted">Nothing posted yet.</p>
          ) : (
            updates.map((u) => (
              <div key={u.id} className="border-b border-line pb-2.5 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-baseline gap-2 text-xs text-subtle">
                  {/* The health as it was, not as it is now — so a run of updates reads as a
                      narrative rather than every past entry adopting today's colour. */}
                  <span className="text-text">{projectHealthLabels[u.health]}</span>
                  <span>{clock.date(u.at)}</span>
                  {u.author && <span>· {u.author.name}</span>}
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text">{u.body}</p>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AddRisk({ projectId, users }: { projectId: string; users: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ProjectRiskKind>("RISK");
  const [severity, setSeverity] = useState<ProjectRiskSeverity>("MEDIUM");
  const [mitigation, setMitigation] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [pending, startTransition] = useTransition();

  if (!open) {
    return (
      <Button size="sm" variant="secondary" className="w-full" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Raise a risk or issue
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      {/* aria-label rather than a Label/htmlFor pairing throughout this form: the fields are
          deliberately unlabelled on screen — the placeholders carry the wording and the row reads as
          one line — so pairing would mean adding visible labels this layout does not have. */}
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What might go wrong?"
        aria-label="Risk or issue"
      />
      <div className="flex flex-wrap gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value as ProjectRiskKind)} aria-label="Kind">
          {(Object.keys(riskKindLabels) as ProjectRiskKind[]).map((k) => (
            <option key={k} value={k}>
              {riskKindLabels[k]}
            </option>
          ))}
        </Select>
        <Select
          value={severity}
          onChange={(e) => setSeverity(e.target.value as ProjectRiskSeverity)}
          aria-label="Severity"
        >
          {(Object.keys(riskSeverityLabels) as ProjectRiskSeverity[]).map((s) => (
            <option key={s} value={s}>
              {riskSeverityLabels[s]}
            </option>
          ))}
        </Select>
        <Select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
          <option value="">Nobody yet</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
      </div>
      <Textarea
        rows={2}
        value={mitigation}
        onChange={(e) => setMitigation(e.target.value)}
        placeholder="What are we doing about it?"
        aria-label="Mitigation"
      />
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={pending || !title.trim()}
          onClick={() =>
            startTransition(async () => {
              await saveRisk({ projectId, kind, title, severity, status: "OPEN", mitigation, ownerId });
              setTitle("");
              setMitigation("");
              setOpen(false);
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : "Raise it"}
        </Button>
      </div>
    </div>
  );
}

function AddUpdate({ projectId, currentHealth }: { projectId: string; currentHealth: ProjectHealth }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [health, setHealth] = useState<ProjectHealth>(currentHealth);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <Textarea
        rows={3}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Where things stand this week…"
        aria-label="Update"
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="update-health" className="text-xs">
            Health
          </Label>
          <Select id="update-health" value={health} onChange={(e) => setHealth(e.target.value as ProjectHealth)}>
            {(Object.keys(projectHealthLabels) as ProjectHealth[]).map((h) => (
              <option key={h} value={h}>
                {projectHealthLabels[h]}
              </option>
            ))}
          </Select>
        </div>
        <Button
          size="sm"
          disabled={pending || !body.trim()}
          onClick={() =>
            startTransition(async () => {
              await postUpdate({ projectId, body, health });
              setBody("");
              router.refresh();
            })
          }
        >
          {pending ? "Posting…" : "Post"}
        </Button>
      </div>
      <p className="text-xs text-subtle">Posting also sets the project&apos;s health, so the two can&apos;t disagree.</p>
    </div>
  );
}
