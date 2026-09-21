import Link from "next/link";
import { Plus } from "lucide-react";
import type { ProjectHealth, ProjectStatus } from "@prisma/client";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { listProjects } from "@/actions/project";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import {
  daysLate,
  isClosed,
  milestoneProgress,
  projectHealthLabels,
  projectHealthTone,
  projectStatusLabels,
  projectStatusTone,
} from "@/lib/projects/status";
import { Badge, Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * Every project this person is on.
 *
 * "Is on" rather than "can see" — the list composes the same stakeholders-only filter as the detail
 * page. A list that quietly shows one more row than the detail page will open is the leak that
 * nobody screenshots and everybody notices.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; health?: string }>;
}) {
  if (!(await isModuleEnabled("projects"))) return <ModuleDisabledNotice moduleKey="projects" />;

  const params = await searchParams;
  const user = await requireUser();
  const [projects, canManage] = await Promise.all([
    listProjects({
      q: params.q,
      status: (params.status as ProjectStatus) || undefined,
      health: (params.health as ProjectHealth) || undefined,
    }),
    hasEffectivePermission(user.id, "projects.manage"),
  ]);

  const now = new Date();

  return (
    <div className="animate-fade-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Projects</h1>
          <p className="mt-1 text-sm text-muted">
            Delivered work, visible to the people on it.
          </p>
        </div>
        {canManage && (
          <Link href="/projects/new">
            <Button>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              New project
            </Button>
          </Link>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <SearchParamInput paramName="q" placeholder="Search projects, customers or references…" />
        <SelectParamFilter
          paramName="status"
          allLabel="Any status"
          options={Object.entries(projectStatusLabels).map(([value, label]) => ({ value, label }))}
        />
        <SelectParamFilter
          paramName="health"
          allLabel="Any health"
          options={Object.entries(projectHealthLabels).map(([value, label]) => ({ value, label }))}
        />
      </div>

      {projects.length === 0 ? (
        <Card className="mt-5">
          <CardContent className="py-10 text-center text-sm text-muted">
            Nothing here. Either there are no projects yet, or you haven&apos;t been added to any —
            projects are visible to their stakeholders.
          </CardContent>
        </Card>
      ) : (
        <div className="mt-5 space-y-3">
          {projects.map((p) => {
            const progress = milestoneProgress(p.milestones.map((m) => ({ completedAt: m.completedAt ? new Date(m.completedAt) : null })));
            const late = daysLate(
              {
                targetEndDate: p.targetEndDate ? new Date(p.targetEndDate) : null,
                actualEndDate: p.actualEndDate ? new Date(p.actualEndDate) : null,
                status: p.status,
              },
              now,
            );
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="block">
                <Card className="transition hover:border-line-strong">
                  <CardContent className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-subtle">{p.code}</span>
                        <span className="text-sm font-medium text-text">{p.name}</span>
                        <Badge tone={projectStatusTone[p.status]}>{projectStatusLabels[p.status]}</Badge>
                        {!isClosed(p.status) && p.health !== "ON_TRACK" && (
                          <Badge tone={projectHealthTone[p.health]}>{projectHealthLabels[p.health]}</Badge>
                        )}
                      </div>
                      <p className="mt-1 text-sm text-muted">
                        {p.company.name}
                        {p.type && ` · ${p.type.name}`}
                        {p.manager && ` · ${p.manager.name}`}
                      </p>
                      <p className="mt-0.5 text-xs text-subtle">
                        {p.targetEndDate && `Promised ${formatDate(new Date(p.targetEndDate))}`}
                        {/* Said plainly, because a slipping project is the one thing a list of
                            projects exists to surface. */}
                        {late !== null && <span className="text-danger"> · {late} days late</span>}
                        {p._count.risks > 0 && ` · ${p._count.risks} risk${p._count.risks === 1 ? "" : "s"}`}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      {p.value != null && (
                        <div className="text-sm font-medium text-text">{formatCurrency(Number(p.value))}</div>
                      )}
                      {progress.percent !== null && (
                        <div className="mt-1 text-xs text-muted">
                          {progress.done}/{progress.total} milestones
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
