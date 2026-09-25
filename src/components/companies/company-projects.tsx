import Link from "next/link";
import type { listProjects } from "@/actions/project";
import {
  daysLate,
  isClosed,
  milestoneProgress,
  projectHealthLabels,
  projectHealthTone,
  projectStatusLabels,
  projectStatusTone,
} from "@/lib/projects/status";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/utils";

type ProjectRow = Awaited<ReturnType<typeof listProjects>>[number];

/**
 * A customer's projects, on the customer page.
 *
 * Only the ones this person could open from the Projects module — `listProjects` applies the same
 * stakeholders-only rule the module does, so a project appears here exactly when its own page would
 * let you in. Someone on none of this customer's projects sees an empty tab, and is told why.
 */
export function CompanyProjects({
  companyId,
  projects,
  canCreate,
  asOf,
}: {
  companyId: string;
  projects: ProjectRow[];
  canCreate: boolean;
  asOf: Date;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between text-sm font-medium text-text">
        <span>Projects</span>
        {canCreate && (
          <Link href={`/projects/new?companyId=${companyId}`}>
            <Button variant="secondary" size="sm">
              New project
            </Button>
          </Link>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">Project</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Manager</th>
              <th className="px-4 py-2.5">Promised</th>
              <th className="px-4 py-2.5">Milestones</th>
              <th className="px-4 py-2.5 text-right">Value</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const progress = milestoneProgress(
                p.milestones.map((m) => ({ completedAt: m.completedAt ? new Date(m.completedAt) : null })),
              );
              const late = daysLate(
                {
                  targetEndDate: p.targetEndDate ? new Date(p.targetEndDate) : null,
                  actualEndDate: p.actualEndDate ? new Date(p.actualEndDate) : null,
                  status: p.status,
                },
                asOf,
              );
              return (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2.5">
                    <Link href={`/projects/${p.id}`} className="font-medium text-text hover:underline">
                      {p.name}
                    </Link>
                    <span className="block font-mono text-[11px] text-subtle">
                      {p.code}
                      {p.type && ` · ${p.type.name}`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={projectStatusTone[p.status]}>{projectStatusLabels[p.status]}</Badge>
                      {!isClosed(p.status) && p.health !== "ON_TRACK" && (
                        <Badge tone={projectHealthTone[p.health]}>{projectHealthLabels[p.health]}</Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">{p.manager?.name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {p.targetEndDate ? formatDate(new Date(p.targetEndDate)) : "—"}
                    {late !== null && <span className="block text-[11px] text-danger">{late} days late</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {progress.percent === null ? "—" : `${progress.done}/${progress.total}`}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted">
                    {p.value != null ? formatCurrency(Number(p.value)) : "—"}
                  </td>
                </tr>
              );
            })}
            {projects.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-subtle">
                  No projects you&apos;re on for this company. Projects are visible to their stakeholders.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
