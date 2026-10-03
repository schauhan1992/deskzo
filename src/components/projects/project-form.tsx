"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProjectHealth, ProjectStatus } from "@prisma/client";
import { saveProject } from "@/actions/project";
import { projectHealthLabels, projectStatusLabels, PROJECT_PIPELINE } from "@/lib/projects/status";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/bulk-select";

type Options = {
  types: { id: string; name: string }[];
  users: { id: string; name: string }[];
  companies: { id: string; name: string }[];
};

type Existing = {
  id: string;
  companyId: string;
  typeId: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  health: ProjectHealth;
  startDate: string | Date | null;
  targetEndDate: string | Date | null;
  actualEndDate: string | Date | null;
  managerId: string | null;
  value: string | number | null;
};

/**
 * A saved date back into its field. `saveProject` holds the day typed as midnight UTC, so its UTC day is
 * the day typed, in any zone — a clock's day would be the one before in a zone west of UTC.
 */
const day = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : "");

/** `ON_HOLD` and `CANCELLED` are reachable from anywhere, so they sit after the pipeline. */
const ALL_STATUSES: ProjectStatus[] = [...PROJECT_PIPELINE, "ON_HOLD", "CANCELLED"];

export function ProjectForm({
  options,
  existing,
  defaultCompanyId,
}: {
  options: Options;
  existing?: Existing;
  defaultCompanyId?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [companyId, setCompanyId] = useState(existing?.companyId ?? defaultCompanyId ?? "");
  const [typeId, setTypeId] = useState(existing?.typeId ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [status, setStatus] = useState<ProjectStatus>(existing?.status ?? "PROPOSED");
  const [health, setHealth] = useState<ProjectHealth>(existing?.health ?? "ON_TRACK");
  const [startDate, setStartDate] = useState(day(existing?.startDate));
  const [targetEndDate, setTargetEndDate] = useState(day(existing?.targetEndDate));
  const [actualEndDate, setActualEndDate] = useState(day(existing?.actualEndDate));
  const [managerId, setManagerId] = useState(existing?.managerId ?? "");
  const [value, setValue] = useState(existing?.value != null ? String(existing.value) : "");
  const [applyTemplate, setApplyTemplate] = useState(true);

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveProject({
        id: existing?.id,
        companyId,
        typeId,
        name,
        description,
        status,
        health,
        startDate,
        targetEndDate,
        actualEndDate,
        managerId,
        value,
        applyTemplate: !existing && applyTemplate,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/projects/${result.data.id}`);
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">
        {existing ? "Edit project" : "New project"}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="company">Customer</Label>
            <Select id="company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} disabled={!!existing}>
              <option value="">Choose…</option>
              {options.companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="type">Kind of work</Label>
            <Select id="type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">Not set</option>
              {options.types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Exchange 2016 to Microsoft 365"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="description">What it covers</Label>
          <Textarea id="description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="status">Status</Label>
            <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
              {ALL_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {projectStatusLabels[s]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="health">Health</Label>
            <Select id="health" value={health} onChange={(e) => setHealth(e.target.value as ProjectHealth)}>
              {(Object.keys(projectHealthLabels) as ProjectHealth[]).map((h) => (
                <option key={h} value={h}>
                  {projectHealthLabels[h]}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="manager">Project manager</Label>
            <Select id="manager" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
              <option value="">Nobody yet</option>
              {options.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="start">Starts</Label>
            <Input id="start" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="target">Promised by</Label>
            <Input id="target" type="date" value={targetEndDate} onChange={(e) => setTargetEndDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="actual">Actually finished</Label>
            <Input id="actual" type="date" value={actualEndDate} onChange={(e) => setActualEndDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="value">Contract value</Label>
            <Input id="value" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </div>

        {!existing && typeId && (
          <label className="flex items-center gap-2 text-sm text-text">
            <Checkbox checked={applyTemplate} onChange={() => setApplyTemplate(!applyTemplate)} />
            Start from this project type&apos;s standard plan
          </label>
        )}

        {!existing && (
          <p className="text-xs text-subtle">
            Projects are visible to the people on them. You and the project manager are added automatically —
            add the rest of the team once it exists.
          </p>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex gap-2">
          <Button onClick={submit} disabled={pending || !companyId || !name.trim()}>
            {pending ? "Saving…" : existing ? "Save" : "Create project"}
          </Button>
          <Button variant="secondary" onClick={() => router.back()}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
